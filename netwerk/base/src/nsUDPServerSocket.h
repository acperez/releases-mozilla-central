/* vim:set ts=2 sw=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef nsUDPServerSocket_h__
#define nsUDPServerSocket_h__

#include "nsIUDPServerSocket.h"
#include "nsSocketTransportService2.h"
#include "mozilla/Mutex.h"

//-----------------------------------------------------------------------------

class nsUDPServerSocket : public nsASocketHandler
                        , public nsIUDPServerSocket
{
public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIUDPSERVERSOCKET

  // nsASocketHandler methods:
  virtual void OnSocketReady(PRFileDesc *fd, int16_t outFlags);
  virtual void OnSocketDetached(PRFileDesc *fd);
  virtual void IsLocal(bool *aIsLocal);

  nsUDPServerSocket();

  // This must be public to support older compilers (xlC_r on AIX)
  virtual ~nsUDPServerSocket();

private:
  void OnMsgClose();
  void OnMsgAttach();

  // try attaching our socket (mFD) to the STS's poll list.
  nsresult TryAttach();

  // lock protects access to mListener; so it is not cleared while being used.
  mozilla::Mutex                    mLock;
  PRFileDesc                       *mFD;
  PRNetAddr                         mAddr;
  nsCOMPtr<nsIUDPServerSocketListener> mListener;
  nsCOMPtr<nsIEventTarget>          mListenerTarget;
  bool                              mAttached;
};

//-----------------------------------------------------------------------------

#endif // nsUDPServerSocket_h__
