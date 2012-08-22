/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef _NSKEYGENHANDLER_H_
#define _NSKEYGENHANDLER_H_
// Form Processor 
#include "nsIFormProcessor.h" 
#include "nsVoidArray.h" 
#include "nsTArray.h" 

nsresult GetSlotWithMechanism(uint32_t mechanism,
                              nsIInterfaceRequestor *ctx,
                              PK11SlotInfo **retSlot);

#define DEFAULT_RSA_KEYGEN_PE 65537L
#define DEFAULT_RSA_KEYGEN_ALG SEC_OID_PKCS1_MD5_WITH_RSA_ENCRYPTION

SECKEYECParams *decode_ec_params(const char *curve);

class nsKeygenFormProcessor : public nsIFormProcessor { 
public: 
  nsKeygenFormProcessor(); 
  virtual ~nsKeygenFormProcessor();
  nsresult Init();

  NS_IMETHOD ProcessValue(nsIDOMHTMLElement *aElement, 
                          const nsAString& aName, 
                          nsAString& aValue); 

  NS_IMETHOD ProvideContent(const nsAString& aFormType, 
                            nsTArray<nsString>& aContent, 
                            nsAString& aAttribute); 
  NS_DECL_ISUPPORTS 

  static nsresult Create(nsISupports* aOuter, const nsIID& aIID, void* *aResult);

protected:
  nsresult GetPublicKey(nsAString& aValue, nsAString& aChallenge, 
			nsAFlatString& akeyType, nsAString& aOutPublicKey,
			nsAString& aPqg);
  nsresult GetSlot(uint32_t aMechanism, PK11SlotInfo** aSlot);
private:
  nsCOMPtr<nsIInterfaceRequestor> m_ctx;

  typedef struct SECKeySizeChoiceInfoStr {
      nsString name;
      int size;
  } SECKeySizeChoiceInfo;

  enum { number_of_key_size_choices = 2 };

  SECKeySizeChoiceInfo mSECKeySizeChoiceList[number_of_key_size_choices];
};

#endif //_NSKEYGENHANDLER_H_
