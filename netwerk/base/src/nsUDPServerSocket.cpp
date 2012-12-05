/* vim:set ts=2 sw=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsIServiceManager.h"
#include "nsSocketTransport2.h"
#include "nsUDPServerSocket.h"
#include "nsProxyRelease.h"
#include "nsAutoPtr.h"
#include "nsError.h"
#include "nsNetCID.h"
#include "prnetdb.h"
#include "prio.h"
#include "mozilla/Attributes.h"

using namespace mozilla;

static NS_DEFINE_CID(kSocketTransportServiceCID, NS_SOCKETTRANSPORTSERVICE_CID);

//-----------------------------------------------------------------------------

typedef void (nsUDPServerSocket:: *nsUDPServerSocketFunc)(void);

static nsresult
PostEvent(nsUDPServerSocket *s, nsUDPServerSocketFunc func)
{
  nsCOMPtr<nsIRunnable> ev = NS_NewRunnableMethod(s, func);
  if (!ev)
    return NS_ERROR_OUT_OF_MEMORY;

  if (!gSocketTransportService)
    return NS_ERROR_FAILURE;

  return gSocketTransportService->Dispatch(ev, NS_DISPATCH_NORMAL);
}

//-----------------------------------------------------------------------------
// nsServerSocket
//-----------------------------------------------------------------------------

nsUDPServerSocket::nsUDPServerSocket()
  : mLock("nsServerSocket.mLock")
  , mFD(nullptr)
  , mAttached(false)
{
  // we want to be able to access the STS directly, and it may not have been
  // constructed yet.  the STS constructor sets gSocketTransportService.
  if (!gSocketTransportService)
  {
    // This call can fail if we're offline, for example.
    nsCOMPtr<nsISocketTransportService> sts =
        do_GetService(kSocketTransportServiceCID);
  }
  // make sure the STS sticks around as long as we do
  NS_IF_ADDREF(gSocketTransportService);
}

nsUDPServerSocket::~nsUDPServerSocket()
{
  Close(); // just in case :)

  // release our reference to the STS
  nsSocketTransportService *serv = gSocketTransportService;
  NS_IF_RELEASE(serv);
}

void
nsUDPServerSocket::OnMsgClose()
{
  SOCKET_LOG(("nsServerSocket::OnMsgClose [this=%p]\n", this));

  if (NS_FAILED(mCondition))
    return;

  // tear down socket.  this signals the STS to detach our socket handler.
  mCondition = NS_BINDING_ABORTED;

  // if we are attached, then we'll close the socket in our OnSocketDetached.
  // otherwise, call OnSocketDetached from here.
  if (!mAttached)
    OnSocketDetached(mFD);
}

void
nsUDPServerSocket::OnMsgAttach()
{
  SOCKET_LOG(("nsServerSocket::OnMsgAttach [this=%p]\n", this));

  if (NS_FAILED(mCondition))
    return;

  mCondition = TryAttach();

  // if we hit an error while trying to attach then bail...
  if (NS_FAILED(mCondition))
  {
    NS_ASSERTION(!mAttached, "should not be attached already");
    OnSocketDetached(mFD);
  }
}

nsresult
nsUDPServerSocket::TryAttach()
{
  nsresult rv;

  if (!gSocketTransportService)
    return NS_ERROR_FAILURE;

  //
  // find out if it is going to be ok to attach another socket to the STS.
  // if not then we have to wait for the STS to tell us that it is ok.
  // the notification is asynchronous, which means that when we could be
  // in a race to call AttachSocket once notified.  for this reason, when
  // we get notified, we just re-enter this function.  as a result, we are
  // sure to ask again before calling AttachSocket.  in this way we deal
  // with the race condition.  though it isn't the most elegant solution,
  // it is far simpler than trying to build a system that would guarantee
  // FIFO ordering (which wouldn't even be that valuable IMO).  see bug
  // 194402 for more info.
  //
  if (!gSocketTransportService->CanAttachSocket())
  {
    nsCOMPtr<nsIRunnable> event =
      NS_NewRunnableMethod(this, &nsUDPServerSocket::OnMsgAttach);
    if (!event)
      return NS_ERROR_OUT_OF_MEMORY;

    nsresult rv = gSocketTransportService->NotifyWhenCanAttachSocket(event);
    if (NS_FAILED(rv))
      return rv;
  }

  //
  // ok, we can now attach our socket to the STS for polling
  //
  rv = gSocketTransportService->AttachSocket(mFD, this);
  if (NS_FAILED(rv))
    return rv;

  mAttached = true;

  //
  // now, configure our poll flags for listening...
  //
  mPollFlags = (PR_POLL_READ | PR_POLL_EXCEPT);
  return NS_OK;
}

//-----------------------------------------------------------------------------
// nsServerSocket::nsASocketHandler
//-----------------------------------------------------------------------------

void
nsUDPServerSocket::OnSocketReady(PRFileDesc *fd, int16_t outFlags)
{
  NS_ASSERTION(NS_SUCCEEDED(mCondition), "oops");
  NS_ASSERTION(mFD == fd, "wrong file descriptor");
  NS_ASSERTION(outFlags != -1, "unexpected timeout condition reached");

  if (outFlags & (PR_POLL_ERR | PR_POLL_HUP | PR_POLL_NVAL))
  {
    NS_WARNING("error polling on listening socket");
    mCondition = NS_ERROR_UNEXPECTED;
    return;
  }

  PRNetAddr clientAddr;
  uint32_t count;
  char buff[1500];

  count = PR_RecvFrom(mFD, buff, sizeof(buff), 0, &clientAddr, PR_INTERVAL_NO_WAIT);

  if (count < 1) {
    NS_WARNING("error of recvfrom on UDP socket");
    return;
  }

  char ip[64];
  PR_NetAddrToString(&clientAddr, ip, sizeof(ip));
  PRUint16 port = PR_ntohs(PR_NetAddrInetPort(&clientAddr));

  nsCString data;
  if (!data.Assign(buff, count - 1, mozilla::fallible_t())) {
    mCondition = NS_ERROR_OUT_OF_MEMORY;
    return;
  }

  nsCString address;
  if (!address.Assign(ip, strlen(ip), mozilla::fallible_t())) {
    mCondition = NS_ERROR_OUT_OF_MEMORY;
    return;
  }

  mListener->OnPacketReceived(this, data, address, port);
}

void
nsUDPServerSocket::OnSocketDetached(PRFileDesc *fd)
{
  // force a failure condition if none set; maybe the STS is shutting down :-/
  if (NS_SUCCEEDED(mCondition))
    mCondition = NS_ERROR_ABORT;

  if (mFD)
  {
    NS_ASSERTION(mFD == fd, "wrong file descriptor");
    PR_Close(mFD);
    mFD = nullptr;
  }

  if (mListener)
  {
    mListener->OnStopListening(this, mCondition);

    // need to atomically clear mListener.  see our Close() method.
    nsIUDPServerSocketListener *listener = nullptr;
    {
      MutexAutoLock lock(mLock);
      mListener.swap(listener);
    }
    // XXX we need to proxy the release to the listener's target thread to work
    // around bug 337492.
    if (listener)
      NS_ProxyRelease(mListenerTarget, listener);
  }
}

void
nsUDPServerSocket::IsLocal(bool *aIsLocal)
{
  // If bound to loopback, this server socket only accepts local connections.
  *aIsLocal = PR_IsNetAddrType(&mAddr, PR_IpAddrLoopback);
}

//-----------------------------------------------------------------------------
// nsServerSocket::nsISupports
//-----------------------------------------------------------------------------

NS_IMPL_THREADSAFE_ISUPPORTS1(nsUDPServerSocket, nsIUDPServerSocket)


//-----------------------------------------------------------------------------
// nsServerSocket::nsIServerSocket
//-----------------------------------------------------------------------------

NS_IMETHODIMP
nsUDPServerSocket::Init(int32_t aPort, bool aLoopbackOnly)
{
  PRNetAddrValue val;
  PRNetAddr addr;

  if (aPort < 0)
    aPort = 0;
  if (aLoopbackOnly)
    val = PR_IpAddrLoopback;
  else
    val = PR_IpAddrAny;

  PR_SetNetAddr(val, PR_AF_INET, aPort, &addr);

  return InitWithAddress(&addr);
}

NS_IMETHODIMP
nsUDPServerSocket::InitWithAddress(const PRNetAddr *aAddr)
{
  NS_ENSURE_TRUE(mFD == nullptr, NS_ERROR_ALREADY_INITIALIZED);

  //
  // configure listening socket...
  //

  mFD = PR_OpenUDPSocket(aAddr->raw.family);
  if (!mFD)
  {
    NS_WARNING("unable to create server socket");
    return NS_ERROR_FAILURE;
  }

  PRSocketOptionData opt;

  opt.option = PR_SockOpt_Reuseaddr;
  opt.value.reuse_addr = true;
  PR_SetSocketOption(mFD, &opt);

  opt.option = PR_SockOpt_Nonblocking;
  opt.value.non_blocking = true;
  PR_SetSocketOption(mFD, &opt);

  if (PR_Bind(mFD, aAddr) != PR_SUCCESS)
  {
    NS_WARNING("failed to bind socket");
    goto fail;
  }

  // get the resulting socket address, which may be different than what
  // we passed to bind.
  if (PR_GetSockName(mFD, &mAddr) != PR_SUCCESS)
  {
    NS_WARNING("cannot get socket name");
    goto fail;
  }

  // wait until AsyncListen is called before polling the socket for
  // client connections.
  return NS_OK;

fail:
  Close();
  return NS_ERROR_FAILURE;
}

NS_IMETHODIMP
nsUDPServerSocket::SendMsg(const nsACString &aMsg, const nsACString &aTargetIp, int32_t aTargetPort)
{
  PRNetAddr addr;
  PR_SetNetAddr(PR_IpAddrNull, PR_AF_INET, aTargetPort, &addr);
  if (PR_StringToNetAddr(aTargetIp.BeginReading(), &addr) != PR_SUCCESS) {
    NS_WARNING("error creating addr");
    return NS_ERROR_FAILURE;
  }

  PRInt32 count = PR_SendTo(mFD, aMsg.BeginReading(), aMsg.Length(), 0, &addr, PR_INTERVAL_NO_WAIT);
  if (count < 0) {
    NS_WARNING("error writting to UDP socket");
    return NS_ERROR_FAILURE;
  }

  return NS_OK;
}

NS_IMETHODIMP
nsUDPServerSocket::Close()
{
  {
    MutexAutoLock lock(mLock);
    // we want to proxy the close operation to the socket thread if a listener
    // has been set.  otherwise, we should just close the socket here...
    if (!mListener)
    {
      if (mFD)
      {
        PR_Close(mFD);
        mFD = nullptr;
      }
      return NS_OK;
    }
  }
  return PostEvent(this, &nsUDPServerSocket::OnMsgClose);
}

namespace {

class ServerSocketListenerProxy MOZ_FINAL : public nsIUDPServerSocketListener
{
public:
  ServerSocketListenerProxy(nsIUDPServerSocketListener* aListener)
    : mListener(aListener)
    , mTargetThread(do_GetCurrentThread())
  { }

  NS_DECL_ISUPPORTS
  NS_DECL_NSIUDPSERVERSOCKETLISTENER

  class OnPacketReceivedRunnable : public nsRunnable
  {
  public:
    OnPacketReceivedRunnable(nsIUDPServerSocketListener* aListener,
                     nsIUDPServerSocket* aServ,
                     const nsACString &aData,
                     const nsACString &aClientIp,
                     int32_t aClientPort)
      : mListener(aListener)
      , mServ(aServ)
      , mData(aData)
      , mClientIp(aClientIp)
      , mClientPort(aClientPort)
    { }

    NS_DECL_NSIRUNNABLE

  private:
    nsCOMPtr<nsIUDPServerSocketListener> mListener;
    nsCOMPtr<nsIUDPServerSocket> mServ;
    nsCString mData;
    nsCString mClientIp;
    int32_t mClientPort;
  };

  class OnStopListeningRunnable : public nsRunnable
  {
  public:
    OnStopListeningRunnable(nsIUDPServerSocketListener* aListener,
                            nsIUDPServerSocket* aServ,
                            nsresult aStatus)
      : mListener(aListener)
      , mServ(aServ)
      , mStatus(aStatus)
    { }

    NS_DECL_NSIRUNNABLE

  private:
    nsCOMPtr<nsIUDPServerSocketListener> mListener;
    nsCOMPtr<nsIUDPServerSocket> mServ;
    nsresult mStatus;
  };

private:
  nsCOMPtr<nsIUDPServerSocketListener> mListener;
  nsCOMPtr<nsIEventTarget> mTargetThread;
};

NS_IMPL_THREADSAFE_ISUPPORTS1(ServerSocketListenerProxy,
                              nsIUDPServerSocketListener)

NS_IMETHODIMP
ServerSocketListenerProxy::OnPacketReceived(nsIUDPServerSocket* aServ,
                                            const nsACString &aData,
                                            const nsACString &aClientIp,
                                            int32_t aClientPort)
{
  nsRefPtr<OnPacketReceivedRunnable> r =
    new OnPacketReceivedRunnable(mListener, aServ, aData, aClientIp, aClientPort);
  return mTargetThread->Dispatch(r, NS_DISPATCH_NORMAL);
}

NS_IMETHODIMP
ServerSocketListenerProxy::OnStopListening(nsIUDPServerSocket* aServ,
                                           nsresult aStatus)
{
  nsRefPtr<OnStopListeningRunnable> r =
    new OnStopListeningRunnable(mListener, aServ, aStatus);
  return mTargetThread->Dispatch(r, NS_DISPATCH_NORMAL);
}

NS_IMETHODIMP
ServerSocketListenerProxy::OnPacketReceivedRunnable::Run()
{
  mListener->OnPacketReceived(mServ, mData, mClientIp, mClientPort);
  return NS_OK;
}

NS_IMETHODIMP
ServerSocketListenerProxy::OnStopListeningRunnable::Run()
{
  mListener->OnStopListening(mServ, mStatus);
  return NS_OK;
}

} // anonymous namespace

NS_IMETHODIMP
nsUDPServerSocket::AsyncListen(nsIUDPServerSocketListener *aListener)
{
  // ensuring mFD implies ensuring mLock
  NS_ENSURE_TRUE(mFD, NS_ERROR_NOT_INITIALIZED);
  NS_ENSURE_TRUE(mListener == nullptr, NS_ERROR_IN_PROGRESS);
  {
    MutexAutoLock lock(mLock);
    mListener = new ServerSocketListenerProxy(aListener);
    mListenerTarget = NS_GetCurrentThread();
  }
  return PostEvent(this, &nsUDPServerSocket::OnMsgAttach);
}

NS_IMETHODIMP
nsUDPServerSocket::GetPort(int32_t *aResult)
{
  // no need to enter the lock here
  uint16_t port;
  if (mAddr.raw.family == PR_AF_INET)
    port = mAddr.inet.port;
  else
    port = mAddr.ipv6.port;
  *aResult = (int32_t) PR_ntohs(port);
  return NS_OK;
}

NS_IMETHODIMP
nsUDPServerSocket::GetAddress(PRNetAddr *aResult)
{
  // no need to enter the lock here
  memcpy(aResult, &mAddr, sizeof(mAddr));
  return NS_OK;
}
