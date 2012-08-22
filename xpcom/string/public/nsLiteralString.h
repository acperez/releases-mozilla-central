/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef nsLiteralString_h___
#define nsLiteralString_h___

#ifndef nscore_h___
#include "nscore.h"
#endif

#ifndef nsDependentString_h___
#include "nsDependentString.h"
#endif


#if 0
inline
const nsDependentString
literal_string( const nsAString::char_type* aPtr )
  {
    return nsDependentString(aPtr);
  }

inline
const nsDependentString
literal_string( const nsAString::char_type* aPtr, uint32_t aLength )
  {
    return nsDependentString(aPtr, aLength);
  }

inline
const nsDependentCString
literal_string( const nsACString::char_type* aPtr )
  {
    return nsDependentCString(aPtr);
  }

inline
const nsDependentCString
literal_string( const nsACString::char_type* aPtr, uint32_t aLength )
  {
    return nsDependentCString(aPtr, aLength);
  }
#endif

#if defined(HAVE_CPP_CHAR16_T) || defined(HAVE_CPP_2BYTE_WCHAR_T)
#if defined(HAVE_CPP_CHAR16_T)
  //PR_STATIC_ASSERT(sizeof(char16_t) == 2);
  #define NS_LL(s)                                u##s
#else
  //PR_STATIC_ASSERT(sizeof(wchar_t) == 2);
  #define NS_LL(s)                                L##s
#endif
  #define NS_MULTILINE_LITERAL_STRING(s)          nsDependentString(reinterpret_cast<const nsAString::char_type*>(s), uint32_t((sizeof(s)/2)-1))
  #define NS_MULTILINE_LITERAL_STRING_INIT(n,s)   n(reinterpret_cast<const nsAString::char_type*>(s), uint32_t((sizeof(s)/2)-1))
  #define NS_NAMED_MULTILINE_LITERAL_STRING(n,s)  const nsDependentString n(reinterpret_cast<const nsAString::char_type*>(s), uint32_t((sizeof(s)/2)-1))
  typedef nsDependentString nsLiteralString;
#else
  #define NS_LL(s)                                s
  #define NS_MULTILINE_LITERAL_STRING(s)          NS_ConvertASCIItoUTF16(s, uint32_t(sizeof(s)-1))
  #define NS_MULTILINE_LITERAL_STRING_INIT(n,s)   n(s, uint32_t(sizeof(s)-1))
  #define NS_NAMED_MULTILINE_LITERAL_STRING(n,s)  const NS_ConvertASCIItoUTF16 n(s, uint32_t(sizeof(s)-1))
  typedef NS_ConvertASCIItoUTF16 nsLiteralString;
#endif

/*
 * Macro arguments used in concatenation or stringification won't be expanded.
 * Therefore, in order for |NS_L(FOO)| to work as expected (which is to expand
 * |FOO| before doing whatever |NS_L| needs to do to it) a helper macro needs
 * to be inserted in between to allow the macro argument to expand.
 * See "3.10.6 Separate Expansion of Macro Arguments" of the CPP manual for a
 * more accurate and precise explanation.
 */

#define NS_L(s)                                   NS_LL(s)

#define NS_LITERAL_STRING(s)                      static_cast<const nsAFlatString&>(NS_MULTILINE_LITERAL_STRING(NS_LL(s)))
#define NS_LITERAL_STRING_INIT(n,s)               NS_MULTILINE_LITERAL_STRING_INIT(n, NS_LL(s))
#define NS_NAMED_LITERAL_STRING(n,s)              NS_NAMED_MULTILINE_LITERAL_STRING(n, NS_LL(s))

#define NS_LITERAL_CSTRING(s)                     static_cast<const nsDependentCString&>(nsDependentCString(s, uint32_t(sizeof(s)-1)))
#define NS_LITERAL_CSTRING_INIT(n,s)              n(s, uint32_t(sizeof(s)-1))
#define NS_NAMED_LITERAL_CSTRING(n,s)             const nsDependentCString n(s, uint32_t(sizeof(s)-1))

typedef nsDependentCString nsLiteralCString;

#endif /* !defined(nsLiteralString_h___) */
