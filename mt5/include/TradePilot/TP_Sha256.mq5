//+------------------------------------------------------------------+
//|                                             TP_Sha256.mq5        |
//|  TradePilot — SHA-256 helper + HMAC-SHA256 for the bridge.       |
//|                                                                  |
//|  MQL5 ships SHA-256 (CryptEncode) but no HMAC, so the HMAC is    |
//|  implemented here with the standard ipad/opad construction. The  |
//|  digest is computed exactly like the backend's Web Crypto HMAC,   |
//|  which is what makes command signature verification possible.     |
//|                                                                  |
//|  This file is #included by TradePilotBridge.mq5; it is not an EA. |
//+------------------------------------------------------------------+
#property copyright "TradePilot"
#property version   "1.00"

#ifndef TP_SHA256_MQH
#define TP_SHA256_MQH

#define TP_SHA256_DIGEST 32
#define TP_HMAC_BLOCK    64

//+------------------------------------------------------------------+
//| Convert a string to UTF-8 bytes (without a terminating null).    |
//+------------------------------------------------------------------+
void TP_StringToBytes(const string text, uchar &out[])
{
   uchar buffer[];
   int copied = StringToCharArray(text, buffer, 0, WHOLE_ARRAY, CP_UTF8);
   if(copied <= 0)
   {
      ArrayResize(out, 0);
      return;
   }
   // StringToCharArray appends a terminating null that must not be hashed.
   int size = copied;
   if(size > 0 && buffer[size - 1] == 0x00)
      size -= 1;
   ArrayResize(out, size);
   for(int i = 0; i < size; i++)
      out[i] = buffer[i];
}

//+------------------------------------------------------------------+
//| Lowercase hex representation of a byte array.                    |
//+------------------------------------------------------------------+
string TP_BytesToHex(const uchar &bytes[])
{
   const string digits = "0123456789abcdef";
   string result = "";
   int size = ArraySize(bytes);
   for(int i = 0; i < size; i++)
   {
      result += StringSubstr(digits, (bytes[i] >> 4) & 0x0F, 1);
      result += StringSubstr(digits, bytes[i] & 0x0F, 1);
   }
   return result;
}

//+------------------------------------------------------------------+
//| SHA-256 of a byte buffer.                                        |
//+------------------------------------------------------------------+
bool TP_Sha256(const uchar &data[], uchar &digest[])
{
   uchar key[];
   uchar result[];
   if(!CryptEncode(CRYPT_HASH_SHA256, data, key, result))
      return false;
   if(ArraySize(result) < TP_SHA256_DIGEST)
      return false;
   ArrayResize(digest, TP_SHA256_DIGEST);
   for(int i = 0; i < TP_SHA256_DIGEST; i++)
      digest[i] = result[i];
   return true;
}

bool TP_Sha256OfString(const string text, uchar &digest[])
{
   uchar bytes[];
   TP_StringToBytes(text, bytes);
   return TP_Sha256(bytes, digest);
}

//+------------------------------------------------------------------+
//| HMAC-SHA256(key, message) — identical to the backend's Web Crypto |
//| HMAC over the canonical command payload.                          |
//+------------------------------------------------------------------+
bool TP_HmacSha256(const uchar &keyBytes[], const uchar &message[], uchar &digest[])
{
   // 1. Normalise the key to exactly one hash block (64 bytes).
   uchar key[TP_HMAC_BLOCK];
   ArrayInitialize(key, 0);

   if(ArraySize(keyBytes) > TP_HMAC_BLOCK)
   {
      uchar shortened[];
      if(!TP_Sha256(keyBytes, shortened))
         return false;
      for(int i = 0; i < ArraySize(shortened); i++)
         key[i] = shortened[i];
   }
   else
   {
      for(int i = 0; i < ArraySize(keyBytes); i++)
         key[i] = keyBytes[i];
   }

   // 2. inner = (key XOR 0x36) || message, then hash it.
   int messageSize = ArraySize(message);
   uchar inner[];
   ArrayResize(inner, TP_HMAC_BLOCK + messageSize);
   for(int i = 0; i < TP_HMAC_BLOCK; i++)
      inner[i] = (uchar)(key[i] ^ 0x36);
   for(int i = 0; i < messageSize; i++)
      inner[TP_HMAC_BLOCK + i] = message[i];

   uchar innerDigest[];
   if(!TP_Sha256(inner, innerDigest))
      return false;

   // 3. outer = (key XOR 0x5C) || innerDigest, then hash it.
   uchar outer[];
   ArrayResize(outer, TP_HMAC_BLOCK + TP_SHA256_DIGEST);
   for(int i = 0; i < TP_HMAC_BLOCK; i++)
      outer[i] = (uchar)(key[i] ^ 0x5C);
   for(int i = 0; i < TP_SHA256_DIGEST; i++)
      outer[TP_HMAC_BLOCK + i] = innerDigest[i];

   return TP_Sha256(outer, digest);
}

bool TP_HmacSha256OfStrings(const string key, const string message, string &hexDigest)
{
   uchar keyBytes[];
   uchar messageBytes[];
   TP_StringToBytes(key, keyBytes);
   TP_StringToBytes(message, messageBytes);
   uchar digest[];
   if(!TP_HmacSha256(keyBytes, messageBytes, digest))
      return false;
   hexDigest = TP_BytesToHex(digest);
   return true;
}

//+------------------------------------------------------------------+
//| Constant-time comparison — never leak a mismatch position.        |
//+------------------------------------------------------------------+
bool TP_HexEqual(const string a, const string b)
{
   int lengthA = StringLen(a);
   if(lengthA != StringLen(b))
      return false;
   int mismatch = 0;
   for(int i = 0; i < lengthA; i++)
      mismatch |= (int)(StringGetCharacter(a, i) ^ StringGetCharacter(b, i));
   return mismatch == 0;
}

//+------------------------------------------------------------------+
//| Random nonce (used when the EA initiates a request).             |
//+------------------------------------------------------------------+
string TP_RandomHex(const int byteCount = 16)
{
   uchar bytes[];
   ArrayResize(bytes, byteCount);
   for(int i = 0; i < byteCount; i++)
      bytes[i] = (uchar)(MathRand() % 256);
   return TP_BytesToHex(bytes);
}

#endif // TP_SHA256_MQH
//+------------------------------------------------------------------+
