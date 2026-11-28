/* Made by make_server_filter.py from the game's mpchat.js: do not edit by hand. */
"use strict";
const mpClean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, "").slice(0, n);
const MP_BAD = ["fuck", "fucking", "fucker", "motherfucker", "shit", "shitty", "bullshit", "bitch", "bitches", "asshole", "bastard", "dick", "dickhead", "cock", "cunt", "pussy", "slut", "whore", "fag", "faggot", "retard", "retarded", "nigger", "nigga", "twat", "wanker", "prick", "piss", "damn", "crap", "douche", "porn", "sex", "nude", "nudes", "kys", "rape", "rapist", "bollocks", "tits", "boobs", "penis", "vagina"];
const MP_LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };
function mpFilterWords(text) {
  /* star only the bad word: check each word (letters, digits and look-alike symbols), ignoring repeats like "fuuuck" */
  return text.replace(/[A-Za-z0-9@$!]+/g, w => { const n = w.toLowerCase().split("").map(ch => MP_LEET[ch] || ch).join(""), sq = n.replace(/(.)\1+/g, "$1");
    const bad = MP_BAD.some(b => n === b || sq === b.replace(/(.)\1+/g, "$1") || (b.length >= 4 && (n.startsWith(b) || n.endsWith(b)) && !/^(class|pass|grass|bass|mass|assum|assign|assist|asset|cocka|cockt|scrap|dickens|shitake|therapist|scunthorpe|cockpit)/.test(n) && !/therapist/.test(n)));
    return bad ? "*".repeat(w.length) : w; }); }
/* chat filter v2 (Petra 2026-11-28): also catches spaced or dotted letters ("f u c k", "f.u.c.k"), sound-alike spellings ("fuk", "phuck"),
   a bad word hidden inside a longer word, and mean words and phrases. Personal info (phone numbers, emails, links, addresses) blocks the message. */
const MP_MEAN = ["stupid", "idiot", "idiots", "loser", "losers", "dumb", "dumbass", "moron", "morons", "ugly", "stfu", "noob", "trash", "pathetic", "freak", "weirdo", "fatso", "fatty", "lame", "suck", "sucks", "dummy", "imbecile"];
const MP_MEAN_PHRASES = [/\bkill\s+(your|ur|yo)\s*self\b/gi, /\bkill\s+urself\b/gi, /\bgo\s+die\b/gi, /\bshut\s+up\b/gi, /\bi\s+hate\s+(you|u)\b/gi, /\bnobody\s+likes\s+(you|u)\b/gi, /\b(you|u)\s+should\s+die\b/gi, /\bkys\b/gi];
const MP_SOUND = ["fuk", "fuc", "fuq", "fuking", "fukin", "fck", "fcking", "fk", "fkn", "phuck", "phuk", "fvck", "fuxk", "sht", "shyt", "shiet", "btch", "biatch", "beech", "biotch", "azz", "azzhole", "dik", "dikhead", "cok", "kock", "kunt", "cnt", "puss", "wh0re", "hore", "slutt", "fagg", "fagget", "nigg", "nigr", "niga", "retrd", "bich", "bish", "wtf", "stfu", "pr0n", "secks", "seggs", "sexx"];
const MP_INSIDE = ["fuck", "cunt", "nigg", "fagg", "bitch", "whore", "shit", "slut", "pussy", "dick"];
const MP_INSIDE_OK = /(shitake|shiitake|dickens|dickinson|benedick|pussywillow|pussycat|scunthorpe|bitcha)/;
function mpCanon(w) { return w.toLowerCase().split("").map(ch => MP_LEET[ch] || ch).join("").replace(/ph/g, "f").replace(/ck/g, "k").replace(/q/g, "k").replace(/v(?=c|k)/g, "u").replace(/(.)\1+/g, "$1"); }
const MP_BAD_C = new Set(MP_BAD.concat(MP_SOUND).map(mpCanon)), MP_MEAN_C = new Set(MP_MEAN.map(mpCanon));
const MP_SAFE = /^(grapes?|drapes?|scrapes?|scraper|trapeze|grapefruit|skyscraper|dickens|dickinson|cocktails?|cockpit|cockatoo|cockroach|peacock|hancock|shitake|shiitake|scunthorpe|assassins?|class(es)?|grass|bass|mass|pass|glass|compass|classic|therapist|analysis|essex|sussex|middlesex|unisex|hello|shell|shellfish|matsuri|nigeria|niger|spice|pussywillow|pussycat|titan|titanic|title|button|bottom|suckers?|hitch|witch|switch|snigger|snicker|sextant|sexton|exit|cucumber|document|circumstance|hoe|hose|horse|whoever|wholesome)$/;
function mpIsBad(w) { if (MP_SAFE.test(w.toLowerCase())) return false; const c = mpCanon(w); if (MP_BAD_C.has(c) || MP_MEAN_C.has(c)) return true; if (MP_INSIDE_OK.test(c)) return false; return MP_INSIDE.some(b => c.includes(mpCanon(b))); }
function mpFilter(text) { text = mpClean(text, 160); text = text.replace(/[A-Za-z0-9@$!]+/g, w => MP_SAFE.test(w.toLowerCase()) ? w : mpFilterWords(w));
  text = text.replace(/[A-Za-z0-9@$!]+/g, w => /^\*+$/.test(w) || !mpIsBad(w) ? w : "*".repeat(w.length));
  /* letters with spaces, dots, dashes or stars between them: join them up and check the whole run */
  text = text.replace(/(?:^|(?<=[^A-Za-z0-9@$!]))(?:[A-Za-z0-9@$!][\s.\-_*,~+]{1,3}){2,}[A-Za-z0-9@$!](?![A-Za-z0-9@$!])/g, run => { const joined = run.replace(/[^A-Za-z0-9@$!]/g, ""); return mpIsBad(joined) || MP_BAD.some(b => mpCanon(joined).includes(mpCanon(b)) && b.length >= 4) ? run.replace(/[A-Za-z0-9@$!]/g, "*") : run; });
  MP_MEAN_PHRASES.forEach(re => { text = text.replace(re, m => m.replace(/[^\s]/g, "*")); });
  return text; }
/* personal info: returns why it's blocked, or "". Prices and scores are fine ("15000 coins", "15,000", "40k", "12345678 points"): a phone number is the 3-3-4 / 3-4 shape
   with dashes, dots, spaces or brackets, a +number, or a long plain number next to words like call / text / number. */
function mpPersonal(text) { const t = String(text || ""), low = t.toLowerCase();
  if (/\(\d{3}\)\s*\d{3}[\s.\-]?\d{4}/.test(t) || /(?<![\d,])\d{3}[\s.\-]\d{3}[\s.\-]\d{4}(?![\d,])/.test(t) || /(?<![\d,])\d{3}[.\-]\d{4}(?![\d,])/.test(t) || /(?<![\w,.])\+\d{8,}(?![\d,.])/.test(t) || (/(?<![\d,.])\d{7,}(?![\d,.])/.test(t) && /\b(call|text|phone|number|cell|mobile|dial|whatsapp|digits|reach\s+me|ring\s+me|txt)\b/i.test(t) && !/\b(points?|score|coins?|xp|level|hp)\b/i.test(t))) return "phone";
  if (/[\w.+\-]+@[\w\-]+\.[a-z]{2,}/i.test(t) || /\b(gmail|hotmail|yahoo|outlook|icloud|aol|proton(mail)?)\b/i.test(low) || /\bat\s+\w+\s+dot\s+(com|net|org)\b/.test(low)) return "email";
  if (/https?:\/\/|www\.|\b[\w\-]+\.(com|net|org|io|gg|tv|ly|me|co|us|uk|xyz|app)\b/i.test(t) || /\b(discord|snapchat|snap|insta|instagram|tiktok|whatsapp|telegram|kik|roblox)\b.{0,12}\b(is|me|name|tag|@|add)\b|\badd\s+me\s+on\b|\b(dm|text|call|message)\s+me\b|\bmy\s+(snap|insta|discord|tiktok|user(name)?)\b/i.test(low)) return "link";
  if (/\b\d{1,5}\s+\w+(\s+\w+)?\s+(street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|boulevard|blvd|way|place|pl|circle|cir|terrace)\b/i.test(t) || /\b(i\s+live\s+(at|on|in|near)|my\s+(home\s+)?address|my\s+house\s+is|my\s+school\s+is|i\s+go\s+to\s+\w+(\s+\w+)?\s+(school|elementary|middle|high))\b/i.test(low) || /\bzip\s*code\b|\bpost\s*code\b/i.test(low)) return "address";
  if (/\bwhere\s+do\s+(you|u)\s+live\b|\bwhere\s+(you|u)\s+live\b|\bhow\s+old\s+(are|r)\s+(you|u)\b|\bwhat('?s|\s+is)\s+(your|ur)\s+(address|number|phone|school|real\s+name|last\s+name|age|email|snap|insta|discord)\b|\bsend\s+(me\s+)?(a\s+)?(pic|pics|photo|picture|selfie)\b/i.test(low)) return "ask";
  if (/\bmy\s+(real\s+|full\s+|last\s+)?name\s+is\b|\bmy\s+(phone|number|cell)\b/i.test(low)) return "name";
  return ""; }
module.exports = { mpFilter, mpPersonal, mpClean };
