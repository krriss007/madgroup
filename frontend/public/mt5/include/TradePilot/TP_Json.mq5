//+------------------------------------------------------------------+
//|                                               TP_Json.mq5        |
//|  TradePilot — minimal, strict JSON reader used by the bridge EA. |
//|                                                                  |
//|  It does three jobs:                                             |
//|    1. dot-path lookups      ("payload.command_id")               |
//|    2. raw slice extraction  (array elements, sub-objects)        |
//|    3. canonical re-writing  (sorted keys, plain decimal numbers) |
//|                                                                  |
//|  (3) is the important one: the backend signs                       |
//|  `… | stableJson(parameters) | …`, so the EA must be able to        |
//|  reproduce that exact string to verify the HMAC. The rules are:    |
//|    • object keys sorted ascending (byte order)                     |
//|    • strings escaped like JavaScript's JSON.stringify               |
//|    • numbers as plain decimals, up to 8 dp, no exponent,           |
//|      integers printed without a decimal point                      |
//|    • booleans true/false, null → null                              |
//|                                                                  |
//|  These rules are mirrored in shared/src/lib/bridge-signature.ts.   |
//+------------------------------------------------------------------+
#property copyright "TradePilot"
#property version   "1.00"

#ifndef TP_JSON_MQH
#define TP_JSON_MQH

#define TP_JSON_STRING 1
#define TP_JSON_NUMBER 2
#define TP_JSON_BOOL   3
#define TP_JSON_NULL   4
#define TP_JSON_OBJECT 5
#define TP_JSON_ARRAY  6

#define TP_JSON_MAX_DEPTH 24

struct TP_JsonNode
{
   string path;      // dot path, e.g. "payload.symbol"
   int    type;      // TP_JSON_*
   string value;     // canonical text for scalars, raw span for containers
   int    start;     // index of the first character in the source document
   int    end;       // index of the last character (inclusive)
};

class TP_Json
{
private:
   string      m_src;
   int         m_len;
   int         m_pos;
   TP_JsonNode m_nodes[];
   int         m_nodeCount;
   bool        m_failed;
   string      m_error;

   void SkipWhitespace()
   {
      while(m_pos < m_len)
      {
         ushort c = StringGetCharacter(m_src, m_pos);
         if(c == ' ' || c == '\t' || c == '\r' || c == '\n')
            m_pos++;
         else
            break;
      }
   }

   void AddNode(const string path, const int type, const string value, const int start, const int end)
   {
      ArrayResize(m_nodes, m_nodeCount + 1);
      m_nodes[m_nodeCount].path  = path;
      m_nodes[m_nodeCount].type  = type;
      m_nodes[m_nodeCount].value = value;
      m_nodes[m_nodeCount].start = start;
      m_nodes[m_nodeCount].end   = end;
      m_nodeCount++;
   }

   //--- read a JSON string literal, returning the decoded text -------------
   bool ParseStringLiteral(string &decoded)
   {
      if(StringGetCharacter(m_src, m_pos) != '"')
      {
         m_error = "expected a string literal";
         return false;
      }
      m_pos++;
      decoded = "";
      while(m_pos < m_len)
      {
         ushort c = StringGetCharacter(m_src, m_pos);
         if(c == '"')
         {
            m_pos++;
            return true;
         }
         if(c == '\\')
         {
            m_pos++;
            ushort esc = StringGetCharacter(m_src, m_pos);
            switch(esc)
            {
               case '"':  decoded += "\""; m_pos++; break;
               case '\\': decoded += "\\"; m_pos++; break;
               case '/':  decoded += "/";  m_pos++; break;
               case 'b':  decoded += "\b"; m_pos++; break;
               case 'f':  decoded += "\f"; m_pos++; break;
               case 'n':  decoded += "\n"; m_pos++; break;
               case 'r':  decoded += "\r"; m_pos++; break;
               case 't':  decoded += "\t"; m_pos++; break;
               case 'u':
               {
                  m_pos++;
                  ushort code = 0;
                  for(int i = 0; i < 4; i++)
                  {
                     ushort h = StringGetCharacter(m_src, m_pos + i);
                     code = (ushort)(code * 16);
                     if(h >= '0' && h <= '9')      code = (ushort)(code + (h - '0'));
                     else if(h >= 'a' && h <= 'f') code = (ushort)(code + (h - 'a' + 10));
                     else if(h >= 'A' && h <= 'F') code = (ushort)(code + (h - 'A' + 10));
                     else { m_error = "bad \\u escape"; return false; }
                  }
                  m_pos += 4;
                  decoded += ShortToString(code);
                  break;
               }
               default:
                  m_error = "unsupported escape sequence";
                  return false;
            }
            continue;
         }
         decoded += ShortToString(c);
         m_pos++;
      }
      m_error = "unterminated string";
      return false;
   }

public:
   TP_Json() { m_len = 0; m_pos = 0; m_nodeCount = 0; m_failed = false; m_error = ""; }

   string Error() { return m_error; }
   bool   Failed() { return m_failed; }

   //--- JavaScript-compatible escaping ------------------------------------
   static string Escape(const string text)
   {
      string out = "\"";
      int size = StringLen(text);
      for(int i = 0; i < size; i++)
      {
         ushort c = StringGetCharacter(text, i);
         if(c == '"')       out += "\\\"";
         else if(c == '\\') out += "\\\\";
         else if(c == 8)    out += "\\b";
         else if(c == 12)   out += "\\f";
         else if(c == 10)   out += "\\n";
         else if(c == 13)   out += "\\r";
         else if(c == 9)    out += "\\t";
         else if(c < 0x20)
         {
            string hex = "0123456789abcdef";
            out += "\\u00";
            out += StringSubstr(hex, (c >> 4) & 0x0F, 1);
            out += StringSubstr(hex, c & 0x0F, 1);
         }
         else
            out += ShortToString(c);
      }
      out += "\"";
      return out;
   }

   //--- plain decimal, up to 8 dp, no exponent (matches the backend) ------
   static string FormatNumber(const string rawNumber)
   {
      double value = StringToDouble(rawNumber);
      if(!MathIsValidNumber(value))
         return "0";
      double rounded = MathRound(value * 100000000.0) / 100000000.0;
      if(MathAbs(rounded) < 1000000000000000.0 && MathAbs(rounded - MathRound(rounded)) < 0.0000000001)
         return StringFormat("%.0f", rounded);
      string text = DoubleToString(rounded, 8);
      // trim trailing zeros then a dangling decimal point
      int end = StringLen(text);
      while(end > 1 && StringGetCharacter(text, end - 1) == '0')
         end--;
      if(end > 1 && StringGetCharacter(text, end - 1) == '.')
         end--;
      text = StringSubstr(text, 0, end);
      if(text == "-0" || text == "")
         text = "0";
      return text;
   }

private:
   bool ParseValue(const string path, const int depth, string &canonical, int &type)
   {
      if(depth > TP_JSON_MAX_DEPTH)
      {
         m_error = "document nested too deeply";
         return false;
      }
      SkipWhitespace();
      if(m_pos >= m_len)
      {
         m_error = "unexpected end of document";
         return false;
      }

      ushort c = StringGetCharacter(m_src, m_pos);

      if(c == '{')
      {
         int start = m_pos;
         AddNode(path, TP_JSON_OBJECT, "", start, start);
         int nodeIndex = m_nodeCount - 1;
         m_pos++;
         string names[];
         string values[];
         int count = 0;
         SkipWhitespace();
         if(m_pos < m_len && StringGetCharacter(m_src, m_pos) == '}')
         {
            m_pos++;
            canonical = "{}";
            m_nodes[nodeIndex].end = m_pos - 1;
            type = TP_JSON_OBJECT;
            return true;
         }
         while(true)
         {
            SkipWhitespace();
            string name;
            if(!ParseStringLiteral(name))
               return false;
            SkipWhitespace();
            if(m_pos >= m_len || StringGetCharacter(m_src, m_pos) != ':')
            {
               m_error = "expected ':'";
               return false;
            }
            m_pos++;
            string childCanonical;
            int childType;
            string childPath = (path == "") ? name : path + "." + name;
            if(!ParseValue(childPath, depth + 1, childCanonical, childType))
               return false;
            ArrayResize(names, count + 1);
            ArrayResize(values, count + 1);
            names[count]  = name;
            values[count] = childCanonical;
            count++;
            SkipWhitespace();
            if(m_pos >= m_len)
            {
               m_error = "unterminated object";
               return false;
            }
            ushort next = StringGetCharacter(m_src, m_pos);
            if(next == ',')
            {
               m_pos++;
               continue;
            }
            if(next == '}')
            {
               m_pos++;
               break;
            }
            m_error = "expected ',' or '}'";
            return false;
         }
         // stable order: sort members by name (byte order)
         for(int i = 1; i < count; i++)
         {
            for(int j = i; j > 0 && names[j] < names[j - 1]; j--)
            {
               string tmpName = names[j];     names[j] = names[j - 1];      names[j - 1] = tmpName;
               string tmpValue = values[j];   values[j] = values[j - 1];    values[j - 1] = tmpValue;
            }
         }
         string built = "{";
         for(int i = 0; i < count; i++)
         {
            if(i > 0)
               built += ",";
            built += Escape(names[i]) + ":" + values[i];
         }
         built += "}";
         canonical = built;
         m_nodes[nodeIndex].end = m_pos - 1;
         type = TP_JSON_OBJECT;
         return true;
      }

      if(c == '[')
      {
         int start = m_pos;
         int nodeIndex = m_nodeCount;
         AddNode(path, TP_JSON_ARRAY, "", start, start);
         m_pos++;
         int itemIndex = 0;
         string itemsCanonical = "";
         SkipWhitespace();
         if(m_pos < m_len && StringGetCharacter(m_src, m_pos) == ']')
         {
            m_pos++;
            canonical = "[]";
            m_nodes[nodeIndex].end = m_pos - 1;
            type = TP_JSON_ARRAY;
            return true;
         }
         while(true)
         {
            string itemCanonical;
            int itemType;
            if(!ParseValue(path + "." + IntegerToString(itemIndex), depth + 1, itemCanonical, itemType))
               return false;
            if(itemIndex > 0)
               itemsCanonical += ",";
            itemsCanonical += itemCanonical;
            itemIndex++;
            SkipWhitespace();
            if(m_pos >= m_len)
            {
               m_error = "unterminated array";
               return false;
            }
            ushort next = StringGetCharacter(m_src, m_pos);
            if(next == ',')
            {
               m_pos++;
               continue;
            }
            if(next == ']')
            {
               m_pos++;
               break;
            }
            m_error = "expected ',' or ']'";
            return false;
         }
         canonical = "[" + itemsCanonical + "]";
         m_nodes[nodeIndex].end = m_pos - 1;
         type = TP_JSON_ARRAY;
         return true;
      }

      if(c == '"')
      {
         int start = m_pos;
         string decoded;
         if(!ParseStringLiteral(decoded))
            return false;
         canonical = Escape(decoded);
         AddNode(path, TP_JSON_STRING, decoded, start, m_pos - 1);
         type = TP_JSON_STRING;
         return true;
      }

      if(c == 't' || c == 'f' || c == 'n')
      {
         int start = m_pos;
         if(StringSubstr(m_src, m_pos, 4) == "true")
         {
            m_pos += 4;
            canonical = "true";
            AddNode(path, TP_JSON_BOOL, "true", start, m_pos - 1);
            type = TP_JSON_BOOL;
            return true;
         }
         if(StringSubstr(m_src, m_pos, 5) == "false")
         {
            m_pos += 5;
            canonical = "false";
            AddNode(path, TP_JSON_BOOL, "false", start, m_pos - 1);
            type = TP_JSON_BOOL;
            return true;
         }
         if(StringSubstr(m_src, m_pos, 4) == "null")
         {
            m_pos += 4;
            canonical = "null";
            AddNode(path, TP_JSON_NULL, "null", start, m_pos - 1);
            type = TP_JSON_NULL;
            return true;
         }
         m_error = "unexpected token";
         return false;
      }

      //--- number -----------------------------------------------------------
      int start = m_pos;
      while(m_pos < m_len)
      {
         ushort d = StringGetCharacter(m_src, m_pos);
         if((d >= '0' && d <= '9') || d == '-' || d == '+' || d == '.' || d == 'e' || d == 'E')
            m_pos++;
         else
            break;
      }
      if(m_pos == start)
      {
         m_error = "unexpected character";
         return false;
      }
      string raw = StringSubstr(m_src, start, m_pos - start);
      canonical = FormatNumber(raw);
      AddNode(path, TP_JSON_NUMBER, raw, start, m_pos - 1);
      type = TP_JSON_NUMBER;
      return true;
   }

   //--- canonical text of an already parsed node --------------------------
   string RawValueAtPath(const string path)
   {
      for(int i = 0; i < m_nodeCount; i++)
      {
         if(m_nodes[i].path == path)
         {
            if(m_nodes[i].type == TP_JSON_STRING)
               return Escape(m_nodes[i].value);
            if(m_nodes[i].type == TP_JSON_NUMBER)
               return FormatNumber(m_nodes[i].value);
            if(m_nodes[i].type == TP_JSON_OBJECT || m_nodes[i].type == TP_JSON_ARRAY)
               return StringSubstr(m_src, m_nodes[i].start, m_nodes[i].end - m_nodes[i].start + 1);
            return m_nodes[i].value;
         }
      }
      return "null";
   }

public:
   //--- parse a document; on success the node table is filled -------------
   bool Parse(const string document)
   {
      m_src = document;
      m_len = StringLen(document);
      m_pos = 0;
      m_nodeCount = 0;
      m_failed = false;
      m_error = "";
      ArrayResize(m_nodes, 0);
      string canonical;
      int type;
      if(!ParseValue("", 0, canonical, type))
      {
         m_failed = true;
         return false;
      }
      return true;
   }

   //--- canonical form of the whole document -------------------------------
   string CanonicalValue(const string path)
   {
      return RawValueAtPath(path);
   }

   bool Has(const string path)
   {
      for(int i = 0; i < m_nodeCount; i++)
         if(m_nodes[i].path == path)
            return true;
      return false;
   }

   int TypeOf(const string path)
   {
      for(int i = 0; i < m_nodeCount; i++)
         if(m_nodes[i].path == path)
            return m_nodes[i].type;
      return 0;
   }

   string GetString(const string path, const string fallback = "")
   {
      for(int i = 0; i < m_nodeCount; i++)
         if(m_nodes[i].path == path)
            return m_nodes[i].value;
      return fallback;
   }

   double GetNumber(const string path, const double fallback = 0.0)
   {
      for(int i = 0; i < m_nodeCount; i++)
         if(m_nodes[i].path == path)
            return StringToDouble(m_nodes[i].value);
      return fallback;
   }

   long GetLong(const string path, const long fallback = 0)
   {
      for(int i = 0; i < m_nodeCount; i++)
         if(m_nodes[i].path == path)
            return (long)StringToInteger(m_nodes[i].value);
      return fallback;
   }

   bool GetBool(const string path, const bool fallback = false)
   {
      for(int i = 0; i < m_nodeCount; i++)
         if(m_nodes[i].path == path)
            return (m_nodes[i].value == "true");
      return fallback;
   }

   //--- number of elements of an array at `path` --------------------------
   int ArraySize2(const string path)
   {
      int count = 0;
      string prefix = path + ".";
      for(int i = 0; i < m_nodeCount; i++)
      {
         if(StringFind(m_nodes[i].path, prefix) == 0)
         {
            string rest = StringSubstr(m_nodes[i].path, StringLen(prefix));
            if(StringFind(rest, ".") < 0)
               count++;
         }
      }
      return count;
   }

   //--- raw JSON text of the array element at `path.index` ----------------
   string ArrayElement(const string path, const int index)
   {
      string elementPath = path + "." + IntegerToString(index);
      for(int i = 0; i < m_nodeCount; i++)
      {
         if(m_nodes[i].path == elementPath)
         {
            if(m_nodes[i].type == TP_JSON_OBJECT || m_nodes[i].type == TP_JSON_ARRAY)
               return StringSubstr(m_src, m_nodes[i].start, m_nodes[i].end - m_nodes[i].start + 1);
            if(m_nodes[i].type == TP_JSON_STRING)
               return Escape(m_nodes[i].value);
            if(m_nodes[i].type == TP_JSON_NUMBER)
               return FormatNumber(m_nodes[i].value);
            return m_nodes[i].value;
         }
      }
      return "";
   }

   int NodeCount() { return m_nodeCount; }
   string PathAt(const int index) { return m_nodes[index].path; }
   int TypeAt(const int index) { return m_nodes[index].type; }
};

//+------------------------------------------------------------------+
//| Convenience: pull the members of `path` whose key matches `key`   |
//| Used for simple "list of objects" documents (e.g. commands[]).    |
//+------------------------------------------------------------------+
int TP_JsonArrayObjects(const string document, const string path, string &items[])
{
   TP_Json json;
   if(!json.Parse(document))
      return 0;
   int count = json.ArraySize2(path);
   ArrayResize(items, count);
   for(int i = 0; i < count; i++)
      items[i] = json.ArrayElement(path, i);
   return count;
}

#endif // TP_JSON_MQH
//+------------------------------------------------------------------+
