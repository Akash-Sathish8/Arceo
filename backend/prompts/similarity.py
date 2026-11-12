"""Prompt matching: "is this already in the library?" (plan section 1).

Someone types or pastes a prompt. Before they save or run it we tell them it's
already in the library ("same"), a variant of one ("close"), or quietly show
related ones. It must hold up when the prompt arrives with real content pasted
in instead of {{blanks}}, against rewording, typos, other blank names, shared
safety boilerplate, and same-category prompts that do a different job. No paid
provider, the same answer every time, nothing per keystroke.

Public API (the contract similar_router, the MCP server and search code against):

    match_draft(draft, org_id, exclude_id=None, k=5, mode="live", public_only=False) -> list[Match]
    similar_to_prompt(prompt_id, org_id, k=6, public_only=False)                  -> list[Match]
    search(query, org_id, scope="all", limit=20)                                  -> list[str]
    invalidate()                                                                  -> None
    seed_near_duplicates(items)                                                   -> list[dict]

`draft` is plain JSON (what POST /api/prompts/similar receives):
    {"body": str, "title"?: str, "description"?: str, "use_case"?: str,
     "variables"?: {name: {"sample"?: str, "expected_tokens"?: int, "untrusted"?: bool}}}

Match (one dict per result, best first):
    {"id", "title", "description", "use_case", "author_name",
     "owned": bool,            # the viewer's org owns the matched prompt
     "copy_of_yours": bool,    # a copy of (or the original of) the prompt being edited
     "level": "same" | "close" | "related",
     "exact": bool,            # the same text once blanks, pasted content and wording are folded
                               # (live typing says "Already in the library" only for these; any
                               # other live "same" reads "Looks like ..." until Save checks it)
     "score": float,           # 0..1, internal ordering only; never shown to people
     "shared": [str], "yours_only": [str], "theirs_only": [str],   # plain-language labels
     "note"?: str}             # optional one-sentence plain explanation

Visibility (same rule as store.list_prompts): a viewer sees their own org's
prompts plus public + published ones, and only the PUBLISHED version of anyone
else's. `org_id=None` or `public_only=True` means public + published only.

How it works (plan §1):
  Stage 1  canonical(): NFKC, invisible format characters dropped, blanks -> §blank,
           fences dropped, the data/review rules and filler removed, pasted content
           (emails, errors, code, notes, pasted articles) detected and turned into
           §blank, numbers -> §num with a separate shape channel, lexicon phrases ->
           concepts, Snowball stems. Side channels: which words come after a
           "don't" / "never" (negation), what the opening asks to DO (OPS), where
           each clause starts (commas, "and", "also", ...) and the value of each
           number.
           Bounded work: at most MAX_CANON_CHARS are read, and no rule rescans the
           text line after line, so crafted text can't make matching slow.
  Stage 2  Index: word uni+bigram TF-IDF, char 3-5-gram TF-IDF, 3-shingles, a
           title+description vector and an inverted index. IDF comes from public
           published prompts only, so no org's private text ever shapes weights.
  Stage 3  candidates: every visible prompt while the library is small
           (FULL_SCAN_MAX), else postings of the query's 12 rarest terms the index
           knows (+ exact hash hits); visibility-filtered, top 40 by word cosine,
           top 15 fully scored.
  Stage 4  pair features (FEATURES: f1-f10 of the plan plus coverage, margin,
           opening and job/output-conflict signals), then three small logistic
           models, all fit by similarity_fit.py into similarity_weights.json:
             - score = sigmoid(w.f + b): ranks candidates and decides "related";
             - verify: "same job?" from job-identity features only (no rank or
               margin, because a hard negative is often the nearest prompt; it
               just does something else with the same words): decides "close";
             - same_gate: the plan's salient-extra rule, learned: neither side
               adds or drops a requirement (coverage asymmetry, whole sentences
               one side lacks, "copied and extended" containment);
             - reword_gate: the same rule for a REWORDED prompt, where how much
               was copied says nothing: clauses left over once the two prompts'
               clauses are lined up, clauses the other side doesn't cover,
               requirement words (format, length, audience, tone, one more thing
               to hand over) and numbers only one side has, and length. Fitted
               against reworded copies with a requirement added or dropped, and
               strict on purpose: when unsure it says "close", which still shows
               the card; Save's AI second opinion can still confirm "same".
           same = exact canonical hash, or verify >= T_same and both gates pass;
           close = verify >= T_close; related = score >= T_related. Two hard
           limits first: another job (opposite or different operations in the
           openings, _op_conflict) is at most related, and a near-copy with a rule
           turned around (neg_flip) is at most close. Then a plain-language
           "Both / Yours also / Theirs also" explanation.
  Stage 6  optional AI second opinion, on Save only (mode="save"; never while
           typing): similarity_judge.py asks Claude Haiku, in one call per draft,
           whether the draft does the same job as the matcher's "same" matches
           (any but an exact copy) and the few candidates it was unsure about.
           A checked "same" stays same ("yes"), becomes close ("partly") or
           related ("no"); otherwise it may promote close -> same, keep close,
           or demote close -> related. Any failure, no key, the ~4 s budget or
           ARCEO_SIMILARITY_JUDGE=0 leaves the deterministic answer untouched.
           The scoring above never changes; only levels and notes of candidates
           the viewer can already see.
"""

from __future__ import annotations

import bisect
import difflib
import hashlib
import json
import math
import re
import threading
import unicodedata
from collections import Counter, OrderedDict
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Optional

import snowballstemmer
import yaml

from .danger import _DATA_RULE, _REVIEW_RULE
from .template import VAR_RE

LEVELS = ("same", "close", "related")
LEXICON_PATH = Path(__file__).with_name("similarity_lexicon.yaml")
WEIGHTS_PATH = Path(__file__).with_name("similarity_weights.json")

BLANK = "§blank"
NUM = "§num"

CANDIDATE_TERMS = 12      # rarest query terms whose postings make the candidate pool
CANDIDATES = 40           # kept by word cosine
RESCORE = 15              # fully featurized and scored
MIN_CONTENT_TOKENS = 3    # below this a draft is too short to match anything
ORG_CACHE_SIZE = 256


# ═════════════════════════════════════════════════════════════════════════
# Lexicon
# ═════════════════════════════════════════════════════════════════════════

_STEMMER = snowballstemmer.stemmer("english")

STOPWORDS = frozenset("""
a about above after again against all am an and any are aren't as at be because been before being below
between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each
few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself
him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't
my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd
she'll she's should shouldn't so some such than that that's the their theirs them themselves then there
there's these they they'd they'll they're they've this those through to too under until up upon very was
wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's
whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves
also just really quite maybe perhaps etc eg ie e.g i.e via per within without whether either neither
will shall may might must need needs needed want wants wanted like would could should can
please kindly thanks thank hi hey hello ok okay yes yeah sure
something anything everything nothing someone anyone everyone thing things stuff way lot lots bit
get gets got getting go goes going gone let lets im ive id dont doesnt didnt cant wont isnt arent
one one's ones whatever whichever paste pasted pasting copied following attached however though although even ever still yet already much many every
""".split())

# Words that say nothing about WHAT a blank holds ("customer_email_text").
_BLANK_FILLER = frozenset("""text content contents input inputs raw here info information detail details data value
values paste pasted full the a an my your our their of to for and or in on with this that these those
item items thing things list""".split())

_NUMBER_WORDS = {
    "zero": "0", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7",
    "eight": "8", "nine": "9", "ten": "10", "eleven": "11", "twelve": "12", "thirteen": "13",
    "fourteen": "14", "fifteen": "15", "sixteen": "16", "seventeen": "17", "eighteen": "18",
    "nineteen": "19", "twenty": "20", "thirty": "30", "forty": "40", "fifty": "50", "sixty": "60",
    "seventy": "70", "eighty": "80", "ninety": "90", "hundred": "100", "thousand": "1000",
    "dozen": "12", "couple": "2", "single": "1", "half": "0.5",
}

# British -ise/-isation forms of common verbs fold into -ize before stemming.
_ISE = re.compile(r"^(organ|summar|priorit|optim|custom|personal|recogn|categor|real|final|standard|apolog|"
                  r"emphas|minim|maxim|util|visual|author|special|general|familiar|memor|critic|modern|"
                  r"character|digit|monet|synchron|initial|normal|stabil|local|central|capital|"
                  r"symbol|mobil|sanit|maxim|fertil)is(e|es|ed|ing|ation|ations|er|ers)$")

_WORD_RE = re.compile(r"§blank|[a-z0-9]+(?:'[a-z]+)?")


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


@dataclass
class Lexicon:
    phrases: dict            # stem tuple -> concept token ("c:<id>")
    labels: dict             # concept token -> plain label
    shapes: dict             # concept token -> output format it names
    max_len: int
    stop_phrases: list       # word tuples dropped before matching
    spelling: dict           # british word -> american word
    stem_overrides: dict     # word -> fixed stem
    roles: dict = field(default_factory=dict)   # concept token -> "action" | "thing" (what a job does / makes)
    requirement: frozenset = frozenset()        # tokens that make a clause a requirement on the output
    opposites: tuple = ()                       # (concept, concept) pairs that point opposite ways

    def stem(self, word: str) -> str:
        return _stem_cached(word, self.stem_overrides.get(word))


@lru_cache(maxsize=200_000)
def _stem_cached(word: str, override: Optional[str]) -> str:
    if override:
        return override
    if word.endswith("'s"):
        word = word[:-2]
    return _STEMMER.stemWord(word)


def _norm_word(word: str, spelling: dict) -> str:
    if word.endswith("'s"):
        word = word[:-2]
    word = spelling.get(word, word)
    m = _ISE.match(word)
    if m:
        word = f"{m.group(1)}iz{m.group(2)}"
    return word


def load_lexicon(path: Path = LEXICON_PATH) -> Lexicon:
    """Parse the lexicon file. Raises ValueError when a term is in two groups."""
    data = yaml.safe_load(Path(path).read_text()) or {}
    spelling = {str(k).lower(): str(v).lower() for k, v in (data.get("spelling") or {}).items()}
    overrides = {str(k).lower(): str(v).lower() for k, v in (data.get("stem_overrides") or {}).items()}
    lex = Lexicon({}, {}, {}, 1, [], spelling, overrides)
    for phrase in data.get("stop_phrases") or []:
        words = tuple(_WORD_RE.findall(str(phrase).lower()))
        if words:
            lex.stop_phrases.append(words)
    lex.stop_phrases.sort(key=len, reverse=True)
    seen_ids: set = set()
    for group in data.get("groups") or []:
        label = str(group["label"]).strip()
        cid = "c:" + _slug(group.get("id") or label)
        if cid in seen_ids:
            raise ValueError(f"lexicon: duplicate group id {cid}")
        seen_ids.add(cid)
        lex.labels[cid] = label
        if group.get("shape"):
            lex.shapes[cid] = str(group["shape"])
        if group.get("role"):
            if group["role"] not in ("action", "thing"):
                raise ValueError(f"lexicon: {cid} role must be action or thing")
            lex.roles[cid] = str(group["role"])
        for term in group.get("terms") or []:
            words = [_norm_word(w, spelling) for w in _WORD_RE.findall(str(term).lower().replace("-", " ")
                                                                    .replace("/", " ").replace("&", " "))]
            key = tuple(lex.stem(w) for w in words)
            if not key:
                continue
            prev = lex.phrases.get(key)
            if prev and prev != cid:
                raise ValueError(f"lexicon: {term!r} is in both {prev} and {cid}")
            lex.phrases[key] = cid
            lex.max_len = max(lex.max_len, len(key))
    req = set()
    for term in data.get("requirement_words") or []:
        toks = [t for t in _tokenize(str(term), lex) if not t.startswith("§")]
        if len(toks) != 1:
            raise ValueError(f"lexicon: requirement word {term!r} must be one word or one group's phrase")
        req.add(toks[0])
    lex.requirement = frozenset(req)
    pairs = []
    for pair in data.get("opposites") or []:
        ids = ["c:" + _slug(str(x)) for x in (pair or [])]
        if len(ids) != 2 or any(i not in lex.labels for i in ids) or ids[0] == ids[1]:
            raise ValueError(f"lexicon: opposites {pair!r} must name two different groups")
        pairs.append((ids[0], ids[1]))
    lex.opposites = tuple(pairs)
    return lex


_LEX: Optional[Lexicon] = None
_LEX_LOCK = threading.Lock()


def lexicon() -> Lexicon:
    global _LEX
    if _LEX is None:
        with _LEX_LOCK:
            if _LEX is None:
                _LEX = load_lexicon()
    return _LEX


def label_of(token: str, surface: Optional[dict] = None) -> str:
    """Plain words for a canonical token: the lexicon label, else the word as the person wrote it."""
    if token.startswith("c:"):
        return lexicon().labels.get(token, token[2:].replace("_", " "))
    if surface and token in surface:
        return surface[token]
    return token


# ═════════════════════════════════════════════════════════════════════════
# Stage 1: canonicalize
# ═════════════════════════════════════════════════════════════════════════

_QUOTES = str.maketrans({
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "´": "'", "`": "`",
    "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"', "«": '"', "»": '"',
    "–": "-", "—": " - ", "−": "-", "‐": "-", "‑": "-", "…": "...",
    " ": " ", "​": "", "•": "-", "●": "-", "▪": "-",
})


def _normalize(text: str) -> str:
    t = unicodedata.normalize("NFKC", text or "")
    if not t.isascii():
        # Invisible format characters copied from Word or a PDF (soft hyphens, zero-width
        # joiners, word joiners, direction marks) would split words: "summ­arize".
        t = "".join(ch for ch in t if unicodedata.category(ch) != "Cf")
    t = t.translate(_QUOTES)
    t = t.replace("\r\n", "\n").replace("\r", "\n")
    t = re.sub(r"[ \t\f\v]+", " ", t)
    # Runs of blank lines are one paragraph break (and keep every line-based rule below linear).
    t = re.sub(r"\n ?(?:\n ?)+", "\n\n", t)
    return t.strip()


# ── payload detection ────────────────────────────────────────────────────
# Tags that wrap INSTRUCTIONS rather than pasted content: keep their text.
_INSTRUCTION_TAGS = frozenset("""instructions instruction task tasks rules rule steps requirements format output
style tone role goal goals constraints guidelines example examples system prompt""".split())

_CODE_FENCE = re.compile(r"```[^\n`]*\n?(.*?)```", re.S)
_TRIPLE = re.compile(r'"""(.*?)"""|\'\'\'(.*?)\'\'\'', re.S)
_SEP_BLOCK = re.compile(r"(^|\n)[ \t]*(-{3,}|={3,}|#{3,}|\*{3,})[ \t]*\n(.*?)\n[ \t]*\2[ \t]*(?=\n|$)", re.S)
_QUOTE_LINES = re.compile(r"(?:^|(?<=\n))((?:[ \t]*>[^\n]*(?:\n|$))+)")
_QUOTED = re.compile(r'"([^"\n]*)"')
_INLINE_LEAD = re.compile(r"^(.*?\S)\s*:\s+(\S.*)$")
_RULE_B_BUDGET = 6000
_TAG_ANY = re.compile(r"</?[A-Za-z_][\w-]*(?:\s[^<>]*)?/?>")

# Words that name pasted content. The blank-concept of a payload is derived from
# the hint word through the lexicon, the same way blank names are.
_PAYLOAD_NOUN = re.compile(
    r"\b(e-?mails?|messages?|dms?|replies|reply|letters?|texts?|notes|transcripts?|minutes|errors?|logs?|"
    r"traces?|tracebacks?|exceptions?|codes?|snippets?|functions?|scripts?|html|css|json|reviews?|comments?|"
    r"feedback|complaints?|posts?|articles?|documents?|docs?|pdfs?|reports?|drafts?|copy|terms|contracts?|"
    r"agreements?|policy|policies|plans?|outlines?|lists?|data|rows|records|spreadsheets?|tables?|answers?|"
    r"responses?|survey|results|bios?|descriptions?|transcriptions?|proposals?|invoices?|receipts?|quotes?|"
    r"testimonials?|sources?|study|summary|summaries|questions?|faqs?|menu|story|stories|ideas|brief|"
    r"announcement|newsletter|captions?|script|page|website|site|chat|conversation|thread)\b", re.I)
_LEAD_CUE = re.compile(
    r"(\bhere(?:'s| is| are)\b|\bbelow (?:is|are)\b|\bpasted\b|\bi got\b|\bi received\b|\bi've got\b|"
    r"\bthey (?:wrote|sent|said)\b|\b(?:he|she) (?:wrote|sent|said)\b|\bit says\b|\bit reads\b|"
    r"\bas follows\b|\bthe following\b|\b(?:this|these|that) (?:is|are) (?:the|my|our|what)\b|\bcopied\b|"
    r"\blook at this\b|\bcheck this\b|\bwritten badly\b|\bin their words\b)", re.I)
_STRONG_INLINE = re.compile(
    r"(?:\bhere(?:'s| is| are)\b[^:]{0,60}|\b(?:this|these|that|the|my|our|his|her|their|its)\s+(?:\w+\s+){0,2}"
    + _PAYLOAD_NOUN.pattern[2:-2] + r")\s*$", re.I)
# A short label in front of pasted content: "Article:", "Their message:", "OLD:", "Reviews:".
_LABEL = re.compile(r"^\s*(?:[-*]\s*)?((?:the |my |our |his |her |their |a |an )?[\w' ]{1,40}?)\s*$", re.I)
_SPEAKER = re.compile(r"^\s*(?:\[?\d{1,2}:\d{2}\]?\s*)?([A-Z][\w.'-]{0,20}(?: [A-Z][\w.'-]{0,20})?)\s*:\s+\S")
# "Tone: friendly", "Length: under 120 words": a spec written as fields, not people talking.
_FIELD_LABELS = frozenset("""tone length format rules rule audience goal goals product details bullets bullet opening
closing style voice topic title subject context constraints constraint output deadline budget language word count
words structure example examples ending intro introduction outro cta notes note purpose task role steps points
requirements must include avoid focus level reader readers platform channel offer price name size""".split())
# "Here's what I need:", "Here's the task:": what follows is the request, not pasted content.
_REQUEST_LEAD = re.compile(
    r"^\s*(?:(?:so|ok|okay|alright)\s*,?\s+)?here(?:'s| is| are)\s+(?:what\s+(?:i|we)(?:'d|\s+would|'m|\s+am|'re|\s+are)?"
    r"\s+(?:need|want|like|after|looking\s+for)|what\s+(?:to\s+do|i\s+want\s+you\s+to\s+do|you\s+(?:need|should|have)\s+to\s+do)"
    r"|how\s+(?:i|we|you|it|this)\b|the\s+(?:task|job|deal|ask|brief|request)|my\s+(?:task|request|ask|question|brief))\b", re.I)
# Pasted messages: people write demands in them ("Fix this now."), so an imperative isn't where they end.
_MESSAGE_NOUN = re.compile(r"\b(?:e-?mails?|messages?|dms?|texts?|letters?|complaints?|comments?|replies|reply|"
                           r"reviews?|chats?|conversation|thread|voicemail)\b", re.I)
# A word that points at text sitting next to the instruction ("summarize THIS", "the notes BELOW").
_POINTER = re.compile(r"\b(?:this|these|that|those|following|below|above|here(?:'s| is| are)?|pasted|attached)\b", re.I)
# A greeting to the AI itself ("Hi Claude,") opens a request, never a pasted email.
_TO_THE_AI = re.compile(r"\b(?:claude|chatgpt|chat gpt|gpt|gemini|copilot|assistant|bard|grok|llama|mistral|"
                        r"perplexity|ai|bot)\b", re.I)


def _speaker(stripped: str) -> bool:
    m = _SPEAKER.match(stripped)
    return bool(m) and m.group(1).strip().lower() not in _FIELD_LABELS


def _instructionish(line: str) -> bool:
    """Does this line carry instruction text (not blank, not pasted, not only the data rule)?"""
    if not line.strip() or BLANK in line:
        return False
    return len(_strip_rules(line.strip()).split()) >= 2
_LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d{1,3}[.)]|[a-z][.)])\s+\S")
_EMAIL_GREETING = re.compile(r"^\s*(hi|hello|hey|dear|good (?:morning|afternoon|evening)|greetings|hiya|yo)\b"
                             r"[^\n]{0,40}?[,!:\n-]", re.I)
_EMAIL_SIGNOFF = re.compile(r"\b(thanks|thank you|thx|best|best regards|regards|kind regards|warm regards|"
                            r"cheers|sincerely|all the best|talk soon|sent from my \w+)\b[,!.]?\s*(?:[-\n ]\s*)?"
                            r"[A-Z][\w.' -]{0,30}\s*$", re.I)
_EMAIL_HEADER = re.compile(r"(^|\n)\s*(from|to|subject|cc|date|sent)\s*:\s*\S", re.I)
_ERROR_SIG = re.compile(
    r"(traceback \(most recent call last\)|\b\w*(?:error|exception)\b\s*:|\buncaught\b|\bat \S+ \(\S+:\d+(?::\d+)?\)|"
    r"\bfile \"[^\"]+\", line \d+|\bERR_[A-Z_]{3,}|\bHTTP\s*[45]\d\d\b|\bstatus(?: code)?:? [45]\d\d\b|"
    r"\b[45]\d\d (?:not found|internal server error|bad request|forbidden|unauthorized)\b|"
    r"\bcannot read propert(?:y|ies)\b|\bis not defined\b|\bis not a function\b|\bnull pointer\b|"
    r"\bsegmentation fault\b|\bundefined method\b|\bno such file or directory\b|"
    r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)", re.I)
_URL_LINE = re.compile(r"^\s*(?:[-*]\s*)?(?:https?://|www\.)\S+\s*$", re.I)
_CODE_CHARS = re.compile(r"[;{}=()<>\[\]]")
_CODE_WORDS = re.compile(r"^\s*(def |function |const |let |var |import |from \S+ import|class |return |if \(|"
                         r"for \(|<div|<\w+[ >]|SELECT |#include|public |private |\$\s|npm |pip )", re.I | re.M)
_INSTRUCTION_START = re.compile(
    r"^\s*(?:[-*\d.)]+\s*)?(?:(?:please|now|then|also|and|finally|next|so|ok|okay|but)\s*,?\s+)?"
    r"(?:can you|could you|would you|will you|i want|i need|i'd like|i would like|help me|let me know|"
    r"for each|for every|for all|in (?:a|one|two|three|plain|simple) |what|how|why|which|whether|is it|"
    r"are there|should|make sure|"
    r"write|summarize|summarise|list|make|keep|use|treat|ignore|give|return|reply|draft|explain|tell|show|add|"
    r"fix|build|create|include|format|output|translate|rewrite|check|find|pull|extract|sort|group|bucket|rank|"
    r"compare|suggest|turn|put|end|start|finish|focus|highlight|answer|respond|do|don't|do not|never|only|"
    r"avoid|label|mark|flag|remember|ensure|organize|organise|split|convert|change|update|edit|proofread|"
    r"shorten|expand|identify|pick|choose|plan|outline|describe|rate|count|calculate|estimate|draw|design|"
    r"go through|look at|read|leave|skip|cluster|tag|note|point out|call out|separate|lead with|open with|"
    r"begin with|no)\b",
    re.I)
def _looks_like_email(block: str) -> bool:
    first = block.strip().split("\n", 1)[0]
    return bool(_EMAIL_HEADER.search(block)) or (
        bool(_EMAIL_GREETING.match(first)) and (bool(_EMAIL_SIGNOFF.search(block.strip())) or len(block.split()) >= 20))


def _looks_like_error(block: str) -> bool:
    return bool(_ERROR_SIG.search(block))


def _looks_like_code(block: str) -> bool:
    chars = len(block)
    if chars < 20:
        return False
    density = len(_CODE_CHARS.findall(block)) / chars
    return density >= 0.06 or len(_CODE_WORDS.findall(block)) >= 2


def _looks_like_urls(block: str) -> bool:
    lines = [ln for ln in block.split("\n") if ln.strip()]
    return bool(lines) and all(_URL_LINE.match(ln) for ln in lines)


def _content_kind(block: str, hint: str = "") -> str:
    """What a pasted block is, as a word the lexicon can map (email / error / code / link / notes / document)."""
    hint_m = _PAYLOAD_NOUN.search(hint or "")
    if _looks_like_error(block):
        return "error"
    if _looks_like_email(block):
        return "email"
    if _looks_like_code(block):
        return "code"
    if _looks_like_urls(block):
        return "link"
    if hint_m:
        return hint_m.group(1).lower()
    lines = [ln for ln in block.split("\n") if ln.strip()]
    if len(lines) >= 2 and sum(len(ln.split()) for ln in lines) / len(lines) <= 9:
        return "notes"
    return "document"


def _is_content(block: str) -> bool:
    return _looks_like_email(block) or _looks_like_error(block) or _looks_like_code(block) or _looks_like_urls(block)


def _only_blank(s: str) -> bool:
    return not re.sub(r"§blank|\s|[\"'`:.,;-]", "", s)


def _inline_end(rest: str) -> int:
    """How much of the text after "Here's the email:" is the pasted content itself."""
    body = rest.lstrip()
    off = len(rest) - len(body)
    if body[:1] == '"':
        close = body.find('"', 1)
        if close > 0:
            return off + close + 1
    if _looks_like_email(body) or len(re.findall(r"(?:^|[.!?]\s+)[A-Z][\w.'-]{0,20}:\s", body)) >= 2:
        return len(rest)
    for m in re.finditer(r"[.!?](?=\s+[A-Z\"'(])", body):
        # a bounded look ahead: slicing the whole rest at every sentence end is quadratic
        if _INSTRUCTION_START.match(body[m.end():m.end() + 120]):
            return off + m.end()
    return len(rest)


def _last_sentence(lead: str) -> str:
    """The sentence a ":" ends: "Below are comments on my post. Reply in the voice of X:" ->
    "Reply in the voice of X". A pointer earlier in the line points at something else."""
    return re.split(r"(?<=[.!?])\s+", lead.strip())[-1]


def _points_at_content(lead: str) -> bool:
    """Does the text before a ":" say pasted content follows ("Here's the email", "Article")?
    "Here's what I need:" introduces the request itself."""
    lead = _last_sentence(lead)
    if _REQUEST_LEAD.match(lead):
        return False
    return bool(_LEAD_CUE.search(lead)) or bool(_STRONG_INLINE.search(lead)) or _is_label(lead)


def _is_label(lead: str) -> bool:
    m = _LABEL.match(lead)
    if not m or len(lead.split()) > 4:
        return False
    return bool(_PAYLOAD_NOUN.search(lead)) or (lead.strip().isupper() and len(lead.strip()) >= 2)


_SIGNOFF_LINE = re.compile(
    r"^\s*(thanks|many thanks|thanks again|thank you|thx|best|best wishes|best regards|regards|kind regards|"
    r"warm regards|warmly|cheers|sincerely|yours|all the best|talk soon|speak soon)\b[,!.]?"
    r"(?:\s*[-,]?\s*[A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,2})?\s*$", re.I)
_GREETING_LINE = re.compile(
    r"^\s*(hi|hello|hey|dear|good (?:morning|afternoon|evening)|greetings|hiya)\b"
    r"(?:[ \t]+[\w.'&-]+){0,3}[ \t]*[,!:.-]?\s*$", re.I)


def _next_index(flags: list) -> list:
    """nxt[k] = the first index >= k where flags is true (len(flags) when none)."""
    n = len(flags)
    nxt = [n] * (n + 1)
    for k in range(n - 1, -1, -1):
        nxt[k] = k if flags[k] else nxt[k + 1]
    return nxt


class _Lines:
    """Per-line facts for extract_payload, computed once, so no rule rescans the text
    from every line (which made crafted text take minutes: "ab:\\n" x 8000)."""

    def __init__(self, lines: list):
        self.lines = lines
        n = len(lines)
        self.n = n
        self.blank_at = _next_index([BLANK in ln for ln in lines])
        self.signoff_at = _next_index([bool(_SIGNOFF_LINE.match(ln)) for ln in lines])
        nonblank = [k for k in range(n) if lines[k].strip()]
        self.last_nonblank = nonblank[-1] if nonblank else -1
        self._next_nonblank = _next_index([bool(ln.strip()) for ln in lines])
        self.instr_at = _next_index([_instructionish(ln) for ln in lines])

    def next_nonblank(self, k: int) -> Optional[int]:
        if k >= self.n:
            return None
        j = self._next_nonblank[k]
        return j if j < self.n else None


class _Before:
    """Whether the output so far holds any instruction text (amortized: `out` only grows)."""

    def __init__(self, out: list):
        self.out, self.upto, self.found = out, 0, False

    def __call__(self) -> bool:
        while not self.found and self.upto < len(self.out):
            ln = self.out[self.upto]
            self.upto += 1
            self.found = _instructionish(ln)
        return self.found


def _email_block_end(lines: list, i: int, before, info: Optional[_Lines] = None) -> Optional[int]:
    """If lines[i] opens a pasted email (a greeting line on its own), the index just past
    its sign-off and signature; else None.

    Conservative on purpose, so a prompt that greets the AI ("Hi! Can you ...") is
    never swallowed: the greeting must be its own short line, a sign-off line must
    follow within 80 lines, and there must be instructions before the email or
    after its signature (otherwise the whole prompt would vanish).

    `before`: the lines already output (a list), or a callable answering "is there
    instruction text before this line?". `info`: precomputed per-line facts.
    """
    line = lines[i]
    if BLANK in line or not _GREETING_LINE.match(line) or _TO_THE_AI.search(line):
        return None
    info = info or _Lines(lines)
    n = info.n
    signoff = info.signoff_at[i + 1] if i + 1 <= n else n
    if signoff >= min(n, i + 80) or info.blank_at[i + 1] < signoff:
        return None
    if signoff == i + 1:
        return None
    body_words = sum(len(lines[k].split()) for k in range(i + 1, signoff))
    if body_words < 8:
        return None
    end = signoff + 1
    # the signature: up to 3 short lines right under the sign-off (name, title, company)
    while end < n and end - signoff <= 3 and lines[end].strip() and len(lines[end].split()) <= 7 \
            and not _INSTRUCTION_START.match(lines[end]) and BLANK not in lines[end]:
        end += 1
    has_before = before() if callable(before) else any(_instructionish(ln) for ln in before)
    has_after = info.instr_at[end] < n if end <= n else False
    return end if (has_before or has_after) else None


_TAG_OPEN = re.compile(r"<([A-Za-z_][\w-]*)(?:\s[^<>]*)?>")
_TAG_CLOSE = re.compile(r"</([A-Za-z_][\w-]*)\s*>")


def _sub_tag_blocks(text: str, fn) -> str:
    """Replace each <name ...>inner</name> block with fn(name, inner). An opening tag pairs
    with the first closing tag of the same name after it (any case), as the regex
    <(name)...>(.*?)</\\1> would, but with no lazy scan to the end of the text for every
    opening tag that never closes ("<a>" x 8000 made that quadratic)."""
    closes: dict = {}
    for m in _TAG_CLOSE.finditer(text):
        closes.setdefault(m.group(1).lower(), []).append(m)
    if not closes:
        return text
    starts = {k: [m.start() for m in v] for k, v in closes.items()}
    out: list = []
    pos = 0
    for m in _TAG_OPEN.finditer(text):
        if m.start() < pos:
            continue
        name = m.group(1).lower()
        if name not in closes:
            continue
        idx = bisect.bisect_left(starts[name], m.end())
        if idx == len(starts[name]):
            continue
        c = closes[name][idx]
        out.append(text[pos:m.start()])
        out.append(fn(m.group(1), text[m.end():c.start()]))
        pos = c.end()
    if not out:
        return text
    out.append(text[pos:])
    return "".join(out)


# An email pasted into the middle of a paragraph: a greeting, at least 40 characters,
# then a sign-off and a capitalized name ("Thanks, Dana", never "best for us").
_MID_GREETING = re.compile(r"(?:^|(?<=[.!?:\n]))\s*((?:hi|hello|hey|dear)\b[^\n,]{0,40},)", re.I)
_MID_SIGNOFF = re.compile(r"\b(?:thanks|thank you|best|regards|cheers|sincerely)\b[,!.]?\s+(?-i:[A-Z][a-z]+)",
                          re.I)


def _mid_paragraph_email(text: str) -> Optional[tuple[int, int]]:
    """(start, end) of the first greeting ... sign-off span, or None. Linear: every greeting
    looks up the first sign-off 40+ characters after its comma instead of scanning for it."""
    signoffs = [(m.start(), m.end()) for m in _MID_SIGNOFF.finditer(text)]
    if not signoffs:
        return None
    starts = [s for s, _ in signoffs]
    for g in _MID_GREETING.finditer(text):
        idx = bisect.bisect_left(starts, g.end() + 40)
        if idx < len(starts):
            if _TO_THE_AI.search(g.group(1)):
                return None                     # "Hi Claude, ... Thanks, Dana": the request itself
            start, end = g.start(1), signoffs[idx][1]
            rest = text[:start] + " " + text[end:]
            # the whole prompt written as a note to the AI ("Hi, can you ... Thanks, Dana") isn't pasted
            if not any(_instructionish(ln) for ln in rest.split("\n")):
                return None
            return start, end
    return None


# An article or document pasted as plain paragraphs with no line pointing at it, before or
# after the instruction that refers to it ("Summarize the article above").
_BACK_POINTER = re.compile(r"\b(?:above|(?:the|this|that)\s+(?:\w+\s+)?" + _PAYLOAD_NOUN.pattern[2:-2] + r")\b", re.I)
_FWD_POINTER = re.compile(r"\b(?:below|following|(?:this|these)\s+(?:\w+\s+)?" + _PAYLOAD_NOUN.pattern[2:-2] + r")\b",
                          re.I)
_FIRST_PERSON = re.compile(r"\b(?:i|i'm|i've|i'd|me|my|we|we're|we've|our|us|you|your)\b", re.I)


def _paragraphs(out: list) -> list:
    """(start, end) line ranges of the non-blank runs in `out`."""
    paras, k, n = [], 0, len(out)
    while k < n:
        if not out[k].strip():
            k += 1
            continue
        j = k
        while j < n and out[j].strip():
            j += 1
        paras.append((k, j))
        k = j
    return paras


def _blank_prose_paste(out: list, kinds: list) -> None:
    """(f) Two or more paragraphs of third-person prose at the very start or very end, with an
    instruction paragraph pointing at them ("the article above" / "this article"), are a paste.
    Your own context ("I run a bakery. We sell ...") has I / we / you in it, so it stays."""
    paras = _paragraphs(out)
    if len(paras) < 3:
        return

    def prose(a: int, b: int) -> bool:
        text = " ".join(out[a:b])
        return (BLANK not in text and len(text.split()) >= 15 and not _FIRST_PERSON.search(text)
                and not _INSTRUCTION_START.match(out[a]) and not _is_content(text))

    def run(order: list) -> int:
        n = 0
        for a, b in order:
            if not prose(a, b):
                break
            n += 1
        return n

    lead = run(paras)
    if lead >= 2 and lead < len(paras):
        a, b = paras[lead]
        if _BACK_POINTER.search(" ".join(out[a:b])):
            s, e = paras[0][0], paras[lead - 1][1]
            kinds.append(_content_kind("\n".join(out[s:e]), " ".join(out[a:b])))
            out[s:e] = [f" {BLANK} "]
            return
    tail = run(list(reversed(paras)))
    if tail >= 2 and tail < len(paras):
        a, b = paras[-tail - 1]
        if _FWD_POINTER.search(" ".join(out[a:b])):
            s, e = paras[-tail][0], paras[-1][1]
            kinds.append(_content_kind("\n".join(out[s:e]), " ".join(out[a:b])))
            out[s:e] = [f" {BLANK} "]


def extract_payload(text: str) -> tuple[str, list[str]]:
    """Replace pasted content with §blank. Returns (text, kinds of what was pasted).

    A block is payload when it is fenced, tagged or quoted; when it follows a
    line ending in ":" and is long (25+ words or several lines) or the line
    points at it ("Here's the email:"); when a short label introduces it
    ("Article: ...", "OLD: ..."); when it looks like content rather than
    instructions: an email, an error or stack trace, code, a transcript, bare
    links; or when two or more third-person paragraphs sit before or after the
    instruction that points at them ("the article above").

    Never payload: the request itself, however it is framed: "Here's what I need:"
    followed by an instruction, a list of requirements under "Include:" or
    "Summarize an article for me:", "Tone: / Length:" spec lines, a "Notes:" label
    over instructions, or a whole prompt written as a note to the AI ("Hi Claude, ...
    Thanks, Dana").
    """
    kinds: list[str] = []

    def _sub_block(inner: str, hint: str) -> str:
        if _only_blank(inner):
            return f" {BLANK} "
        if not inner.strip():
            return " "
        kinds.append(_content_kind(inner, hint))
        return f"\n {BLANK} \n"

    def _tag(name: str, inner: str) -> str:
        name = name.lower()
        if name in _INSTRUCTION_TAGS:
            return f" {inner} "
        return _sub_block(inner, name.replace("_", " ").replace("-", " "))

    for _ in range(3):  # nested tags
        new = _sub_tag_blocks(text, _tag)
        if new == text:
            break
        text = new
    text = _CODE_FENCE.sub(lambda m: _sub_block(m.group(1), "code"), text)
    text = _TRIPLE.sub(lambda m: _sub_block(m.group(1) if m.group(1) is not None else m.group(2), ""), text)
    text = _SEP_BLOCK.sub(lambda m: m.group(1) + _sub_block(m.group(3), ""), text)
    text = _QUOTE_LINES.sub(lambda m: _sub_block(re.sub(r"(^|\n)[ \t]*>", r"\1", m.group(1)), ""), text)

    def _quote(m: re.Match) -> str:
        inner = m.group(1)
        if len(inner.split()) >= 15 or _is_content(inner):
            # what the line calls it ("Their message: ...") says what kind of content it is
            lead = m.string[max(0, m.start() - 60):m.start()].rsplit("\n", 1)[-1]
            return _sub_block(inner, lead).replace("\n", " ")
        return m.group(0)

    # Quotes pair left to right on a line, so the closing quote of one short quote never
    # opens a "quote" that runs to the next one and swallows the instruction between them.
    text = _QUOTED.sub(lambda m: _quote(m) if len(m.group(1)) >= 60 else m.group(0), text)
    text = _QUOTED.sub(lambda m: _quote(m) if len(m.group(1)) >= 8 and _looks_like_error(m.group(1))
                       else m.group(0), text)

    lines = text.split("\n")
    n = len(lines)
    info = _Lines(lines)
    next_nonblank = info.next_nonblank
    out: list[str] = []
    before = _Before(out)
    # Rule (b) scans forward from every line ending in ":". A block it turns down costs a
    # scan; this caps the total (in lines, plus characters / 80) so crafted text can't make
    # matching quadratic. Real prompts use a few dozen units; past the cap only lines that
    # point at pasted content ("Here's the email:") still look ahead.
    budget = _RULE_B_BUDGET
    i = 0

    while i < n:
        line = lines[i]
        stripped = line.strip()
        # (a) a transcript or chat: two or more "Name: words" lines in a row
        if _speaker(stripped) and BLANK not in stripped:
            j = i
            while j < n and _speaker(lines[j].strip()):
                j += 1
            if j - i >= 2:
                kinds.append("transcript")
                out.append(f" {BLANK} ")
                i = j
                continue
        # (a2) an email pasted as its own paragraphs: a greeting line on its own
        #      ("Hi Priya,"), the body, then a sign-off ("Best,\nMarcus Webb"). Real
        #      emails have blank lines between paragraphs, which (b) and the
        #      paragraph-level email rule below don't span.
        end = _email_block_end(lines, i, before, info)
        if end is not None:
            kinds.append("email")
            out.append(f" {BLANK} ")
            i = end
            continue
        # (b) a line ending in ":" and the block under it
        if stripped.endswith(":") and len(stripped) > 1:
            lead = stripped[:-1]
            lead_sent = _last_sentence(lead)
            cue = _points_at_content(lead)
            # "Here's the article:" names what's pasted: its paragraphs run on past blank lines.
            named = cue and bool(_PAYLOAD_NOUN.search(lead_sent))
            # "Summarize an article for me:" / "Include:" with no "this" or "below": a list under it
            # is what the prompt asks for, not pasted content.
            asks = not cue and bool(_INSTRUCTION_START.match(lead_sent)) and not _POINTER.search(lead_sent)
            j = next_nonblank(i + 1) if (cue or budget > 0) else None
            if j is not None and not named and _INSTRUCTION_START.match(lines[j]) and not _is_content(lines[j]):
                j = None            # "Here's what I need:\nSummarize ...": the request itself, not a paste
            block: list[str] = []
            k = j if j is not None else n
            listy = False
            if j is not None:
                listy = bool(_LIST_ITEM.match(lines[j]))
                emaily = bool(_EMAIL_GREETING.match(lines[j]))
                signed = False
                while k < n:
                    cur = lines[k]
                    if not cur.strip():
                        nxt = next_nonblank(k)
                        if nxt is None:
                            break
                        go_on = cue and ((emaily and not signed) or _is_content(lines[nxt])
                                         or lines[nxt].lstrip().startswith('"')
                                         or (listy and _LIST_ITEM.match(lines[nxt]))
                                         or (named and not listy and not _INSTRUCTION_START.match(lines[nxt])
                                             and _instructionish(lines[nxt])))
                        if not go_on or BLANK in lines[nxt]:
                            break
                        block.extend(lines[k:nxt])
                        k = nxt
                        continue
                    if block and listy and not _LIST_ITEM.match(cur):
                        break
                    if block and not listy and not (emaily and not signed) \
                            and _INSTRUCTION_START.match(cur) and not _is_content(cur):
                        break
                    if emaily and _EMAIL_SIGNOFF.search(cur.strip()):
                        signed = True
                    block.append(cur)
                    k += 1
            body = "\n".join(block).strip()
            nonempty = [b for b in block if b.strip()]
            words = len(body.split())
            short_items = bool(nonempty) and all(len(b.split()) <= 8 for b in nonempty)
            if body and not _only_blank(body) and not (asks and listy and not _is_content(body)) and (
                    _is_content(body) or (cue and words >= 4)
                    or ((words >= 25 or len(nonempty) >= 2) and not (short_items and not cue)
                        and not all(_INSTRUCTION_START.match(b) for b in nonempty))):
                out.append(line)
                kinds.append(_content_kind(body, stripped))
                out.append(f" {BLANK} ")
                i = k
                continue
            if j is not None:
                budget -= len(block) + 1 + len(body) // 80
        # (c) inline: "Here's the email: Hi Sam, ..." / "Article: Remote work is ..." / "Fix this error: ..."
        m = _INLINE_LEAD.match(line)
        if m and BLANK not in m.group(2):
            lead, rest = m.group(1), m.group(2)
            lead_sent = _last_sentence(lead)
            strong = _points_at_content(lead)
            if strong and len(lead_sent.split()) <= 3 and not _LEAD_CUE.search(lead_sent) \
                    and _INSTRUCTION_START.match(rest) and not _is_content(rest):
                strong = False      # "Notes: lead with their problem, ...": a label over instructions
            if strong or (_looks_like_error(rest) and _PAYLOAD_NOUN.search(lead_sent)):
                end = _inline_end(rest)
                if strong and _MESSAGE_NOUN.search(lead_sent) and not _INSTRUCTION_START.match(lead_sent) \
                        and (before() or info.instr_at[i + 1] < n):
                    # "Here's the email: I was charged twice. Fix this now. Cancel my plan." The line only
                    # points at a pasted message and the request is on other lines: all of it is the
                    # message, whatever its sender demanded in it.
                    end = len(rest)
                payload, remainder = rest[:end], rest[end:]
                if len(payload.split()) >= 6 or _is_content(payload):
                    kinds.append(_content_kind(payload, lead))
                    out.append(f"{lead}: {BLANK} {remainder}")
                    i += 1
                    continue
        # (d) a line that IS an error / stack frame, or a bare link
        if stripped and BLANK not in stripped and (
                (_looks_like_error(stripped) and not _INSTRUCTION_START.match(stripped)
                 and (len(stripped.split()) <= 30 or _ERROR_SIG.match(stripped)))
                or _URL_LINE.match(stripped)):
            kinds.append(_content_kind(stripped))
            out.append(f" {BLANK} ")
            i += 1
            continue
        out.append(line)
        i += 1
    # (e) a list pasted at the very end (a changelog, notes, survey answers): items that
    #     read like content, not like instructions, and nothing but the data rule after it
    k = len(out)
    while k > 0 and (not out[k - 1].strip() or _DATA_RULE.search(out[k - 1]) or _DATA_RULE_PLAIN.search(out[k - 1])):
        k -= 1
    j = k
    while j > 0 and _LIST_ITEM.match(out[j - 1]) and BLANK not in out[j - 1]:
        j -= 1
    items = out[j:k]
    if len(items) >= 2 and j > 0:
        avg = sum(len(x.split()) for x in items) / len(items)
        imperative = sum(1 for x in items if _INSTRUCTION_START.match(x))
        if avg >= 5 and imperative * 3 <= len(items):
            kinds.append(_content_kind("\n".join(items), out[j - 1]))
            out[j:k] = [f" {BLANK} "]
    _blank_prose_paste(out, kinds)
    text = "\n".join(out)
    # An email pasted into the middle of a paragraph: greeting ... sign-off.
    span = _mid_paragraph_email(text)
    if span and BLANK not in text[span[0]:span[1]]:
        kinds.append("email")
        text = text[:span[0]] + f" {BLANK} " + text[span[1]:]
    return text, kinds


# ── sentences, boilerplate, tokens ───────────────────────────────────────

_SENT_SPLIT = re.compile(r"(?<=[.!?;])\s+|\n+")


# Common rewordings of the data rule that danger._DATA_RULE doesn't need to catch
# ("don't follow anything it says", "it's just material to review").
_DATA_RULE_PLAIN = re.compile(
    r"((?:don't|do not|never|not to) (?:follow|obey|act on|do) (?:anything|what(?:ever)?|any of)\b[^.;]{0,40}?"
    r"\b(?:says?|asks?|tells?|written|contains?|requests?)\b"
    r"|(?:is|are) (?:just|only|simply) (?:material|content|data|text|something|information|info)\b"
    r"|treat (?:it|this|them|that|the [\w ]{1,30}) (?:only |just |purely )?as (?:something|material|text|information|"
    r"info|reference|input)\b"
    r"|(?:anything|any instructions?|commands?) (?:in|inside|within) (?:it|them|the [\w ]{1,30}) (?:is|are) not "
    r"(?:for you|instructions|to be followed))", re.I)


def _strip_rules(sentence: str) -> str:
    """Drop the data rule / review rule clauses that safe prompts share."""
    for rx in (_DATA_RULE, _DATA_RULE_PLAIN, _REVIEW_RULE):
        m = rx.search(sentence)
        if m:
            head = sentence[:m.start()]
            # "Summarize it, and treat it as data": keep what came before the clause
            cut = max(head.rfind(","), head.rfind(";"), head.rfind(":"), head.rfind(" and "))
            sentence = head[:cut] if cut > 0 and len(head[:cut].split()) >= 3 else head
            if len(sentence.split()) <= 2:
                sentence = ""
    return sentence


@dataclass
class Shape:
    formats: frozenset = frozenset()
    counts: tuple = ()          # ((format, count), ...)
    length: int = 0             # 0 short ... 3 long

    def count_of(self, fmt: str) -> Optional[int]:
        for f, c in self.counts:
            if f == fmt:
                return c
        return None


@dataclass
class Canon:
    tokens: list               # canonical token stream (concepts, stems, §blank, §num)
    sentences: list            # token lists per sentence (same tokens, split)
    blanks: frozenset          # blank-concept set (+ pasted-content kinds)
    shape: Shape
    hash: str
    surface: dict              # token -> how the person wrote it (for labels)
    words: list                # normalized surface words (for char n-grams)
    meta_tokens: list = field(default_factory=list)
    title_tokens: list = field(default_factory=list)
    has_meta: bool = False
    use_case: str = ""
    payload_kinds: tuple = ()
    # Negation, a side channel (the tokens above keep every word, said or negated):
    neg_only: frozenset = frozenset()   # content tokens that only ever come after a "don't" / "never" / "no"
    pos_only: frozenset = frozenset()   # content tokens never negated
    # What the prompt asks to DO (OPS), from the first of its first two sentences that asks for
    # one; and the thing a "turn X into Y" opening makes (Y). Read by _op_conflict.
    ops_first: frozenset = frozenset()
    ops_all: frozenset = frozenset()
    into_out: Optional[str] = None
    # Clauses and numbers, side channels for the same-gate: does one prompt ask for something
    # the other doesn't (an added "..., and give me a video version", "under 90 words" vs none)?
    clause_starts: tuple = ()           # token indices where a clause starts (each sentence start too)
    numbers: tuple = ()                 # (token index, value) of every §num with a value

    def clauses(self) -> list:
        """(start, end) token ranges of the clauses, in order; together they cover every token."""
        cuts = list(self.clause_starts) or ([0] if self.tokens else [])
        return [(a, b) for a, b in zip(cuts, cuts[1:] + [len(self.tokens)]) if b > a]

    @property
    def content_len(self) -> int:
        return sum(1 for t in self.tokens if not t.startswith("§"))

    @property
    def head(self) -> frozenset:
        """What the prompt is FOR: its title plus its first two sentences."""
        h = self.__dict__.get("_head")
        if h is None:
            toks = set(self.title_tokens)
            for sent in self.sentences[:2]:
                toks.update(t for t in sent if not t.startswith("§"))
            h = self.__dict__["_head"] = frozenset(toks)
        return h


def _tokenize(text: str, lex: Lexicon, surface: Optional[dict] = None, words_out: Optional[list] = None,
              shape_counts: Optional[list] = None, neg_out: Optional[list] = None,
              clause_out: Optional[list] = None, num_out: Optional[list] = None) -> list[str]:
    """Canonical tokens for one sentence. `neg_out` (optional) gets one bool per output token:
    True when it comes right after a "don't" / "never" / "no" / "without" ("don't invent facts":
    invent; "don't add anything new": add, new). Negation words themselves stay out of the
    tokens, as before, so rewordings still match; the side channel only stops a flipped rule
    ("invent facts" vs "don't invent facts") from looking like the same prompt.

    Two more side channels, also one entry per output token, never changing the tokens:
    `clause_out` gets True where a new clause starts (after a comma, semicolon, colon, bracket
    or dash, or at "and" / "also" / "plus" / "then" / "but"), so a requirement added inside a
    sentence ("..., and add a video version") can be told apart; `num_out` gets the value of
    each §num ("under 90 words": 90.0), None for every other token."""
    low = text.lower()
    found = list(_WORD_RE.finditer(low.replace("-", " ").replace("/", " ").replace("&", " ").replace("_", " ")))
    raw = [m.group(0) for m in found]
    # a clause break sits in the gap before a word: punctuation, or a dash between spaces
    brk = [bool(k) and bool(_CLAUSE_GAP.search(low, found[k - 1].end(), found[k].start()))
           for k in range(len(found))]
    # stop phrases ("you are a helpful assistant", "please")
    if lex.stop_phrases and raw:
        keep = [True] * len(raw)
        i = 0
        while i < len(raw):
            for sp in lex.stop_phrases:
                n = len(sp)
                if tuple(raw[i:i + n]) == sp:
                    for j in range(i, i + n):
                        keep[j] = False
                    i += n - 1
                    break
            i += 1
        kept_raw, kept_brk, carry = [], [], False
        for w, k, b in zip(raw, keep, brk):
            carry = carry or b
            if k:
                kept_raw.append(w)
                kept_brk.append(carry)
                carry = False
        raw, brk = kept_raw, kept_brk
    normed = [_norm_word(w, lex.spelling) for w in raw]
    stems = [w if w == BLANK else lex.stem(w) for w in normed]
    out: list[str] = []
    negs: list[bool] = []
    starts: list[bool] = []
    nums: list = []
    neg = False                     # a negation word is waiting for its content word
    new_clause = True               # the next token starts a clause
    last_num: Optional[tuple[int, float]] = None   # (raw index, value)
    i = 0
    n = len(stems)

    def emit(tok: str, value: Optional[float] = None) -> None:
        nonlocal neg, new_clause
        out.append(tok)
        negs.append(neg and not tok.startswith("§"))
        starts.append(new_clause)
        nums.append(value)
        new_clause = False
        if tok.startswith("§"):
            neg = False
        elif neg and tok not in _NEG_WEAK:
            neg = False

    while i < n:
        w = normed[i]
        if brk[i] or raw[i] in _CLAUSE_WORDS:
            new_clause = True
        if w == BLANK:
            emit(BLANK)
            i += 1
            continue
        matched = None
        for L in range(min(lex.max_len, n - i), 0, -1):
            key = tuple(stems[i:i + L])
            if BLANK in key:
                continue
            cid = lex.phrases.get(key)
            if cid:
                matched = (cid, L)
                break
        if matched:
            cid, L = matched
            emit(cid)
            if surface is not None:
                surface.setdefault(cid, " ".join(raw[i:i + L]))
            if words_out is not None:
                words_out.extend(x for x in normed[i:i + L] if x not in STOPWORDS and len(x) > 2 and x.isalpha())
            fmt = lex.shapes.get(cid)
            if fmt and shape_counts is not None:
                cnt = last_num[1] if last_num and i - last_num[0] <= 3 else None
                shape_counts.append((fmt, cnt))
            i += L
            continue
        if w in _NUMBER_WORDS or (w and w[0].isdigit()):
            val = _NUMBER_WORDS.get(w)
            if val is None:
                mnum = re.match(r"^\d+(?:\.\d+)?", w)
                val = mnum.group(0) if mnum else None
            fval = None
            try:
                fval = float(val) if val is not None else None
            except ValueError:
                pass
            if fval is not None:
                last_num = (i, fval)
            emit(NUM, fval)
            i += 1
            continue
        if raw[i] in _NEGATORS and not (i + 1 < n and raw[i + 1] in _NEG_NOT_REALLY):
            neg = True
            if raw[i] in STOPWORDS:
                i += 1
                continue
        if w in STOPWORDS or raw[i] in STOPWORDS or len(w) < 2:
            i += 1
            continue
        tok = stems[i]
        emit(tok)
        if surface is not None:
            surface.setdefault(tok, raw[i])
        if words_out is not None and len(w) > 2 and w.isalpha():
            words_out.append(w)
        i += 1
    if neg_out is not None:
        neg_out.extend(negs)
    if clause_out is not None:
        clause_out.extend(starts)
    if num_out is not None:
        num_out.extend(nums)
    return out


# ── negation and what a prompt asks to do ───────────────────────────────

_NEGATORS = frozenset("""not no nor never don't dont do't doesn't doesnt didn't didnt won't wont can't cant cannot
shouldn't shouldnt mustn't isn't aren't wasn't without avoid avoiding""".split())
# "no more than 5 bullets", "not only", "no need to": not a rule turned around.
_NEG_NOT_REALLY = frozenset("""more less fewer longer shorter later earlier than only just matter need needed
problem one doubt exception surprise worries worry wonder""".split())
# Where a clause ends inside a sentence (the clause side channel of _tokenize): punctuation or a
# dash between two words, or one of these words. Lexicon phrases are never split ("pros and cons").
_CLAUSE_GAP = re.compile(r"[,;:()\[\]]|\s-+\s")
_CLAUSE_WORDS = frozenset("and also plus then but additionally".split())
# Light verbs a negation reaches past to its real object ("don't use jargon": jargon). They
# carry the negation themselves too, but never count as a flipped rule.
_NEG_WEAK = frozenset("""use includ add put make give say mention tri keep let get go do be have show tell write
c:write""".split())

# What a prompt asks to DO, from its canonical tokens. Opposite operations, or two different
# ways of working on the same input, are different jobs whatever else the prompts share.
OPS = {
    "c:remove": "remove", "c:turn_off": "remove", "c:undo": "remove",
    "c:build": "create", "add": "create", "c:turn_on": "create",
    "c:shorten": "shorten", "c:expand": "expand",
    "c:summarize": "summarize", "c:translate": "translate", "c:reply": "reply", "c:rewrite": "rewrite",
    "c:proofread": "proofread", "c:explain": "explain", "c:evaluate": "evaluate",
    "c:write": "write",
}
OPPOSITE_OPS = (frozenset({"create", "remove"}), frozenset({"shorten", "expand"}))
TRANSFORM_OPS = frozenset({"summarize", "translate", "reply", "rewrite", "proofread", "explain", "evaluate"})

# "turn the review into a public reply": the thing made is the job.
_INTO = re.compile(r"\b(?:turn|turning|convert|converting|make|change|transform|rewrite|reshape|repurpose|rework)\b"
                   r"[^.;:\n]{0,80}?\binto\b\s+([^.;:\n,]{1,60})", re.I)
# "take the gallery off", "turn dark mode on": the particle moves next to its verb, so the
# lexicon sees "take off" / "turn on" ("on" only before the end of the clause or a few words).
_PARTICLE = re.compile(
    r"\b(turn|switch|take|shut)\s+((?:(?:the|my|our|your|this|that|these|those|it|them|a|an)\s+)?"
    r"(?:[\w'§-]+\s+){0,3}?)(off|out|down|on(?=\s*(?:$|[.,;:!?)]|(?:for|again|automatically|by default|when|so|and|if)\b)))\b",
    re.I)


def _op_conflict(q: "Canon", c: "Canon") -> bool:
    """Do the two prompts ask for different jobs, however much else they share?
    Opposite operations in their openings (add vs remove, shorter vs longer), two different
    ways of working on the input that neither prompt mentions the other's (summarize vs
    translate vs reply), or a "turn X into Y" that makes different things."""
    for pair in OPPOSITE_OPS:
        a, b = tuple(pair)
        for x, y in ((a, b), (b, a)):
            if x in q.ops_first and y in c.ops_first and x not in c.ops_first and y not in q.ops_first:
                return True
    qt, ct = q.ops_first & TRANSFORM_OPS, c.ops_first & TRANSFORM_OPS
    if qt and ct and not (qt & c.ops_all) and not (ct & q.ops_all):
        return True
    if q.into_out and c.into_out and q.into_out != c.into_out \
            and q.into_out not in c.pos_only and c.into_out not in q.pos_only:
        return True
    return _opposite_sides(q, c)


def _opposite_sides(q: "Canon", c: "Canon") -> bool:
    """One prompt is about one side of a lexicon `opposites` pair and the other about the other side
    ("happy customers" / "unhappy customers"), at least one of them in its opening, and neither
    mentions both."""
    qa, ca = set(q.tokens) | set(q.title_tokens), set(c.tokens) | set(c.title_tokens)
    for a, b in lexicon().opposites:
        for x, y in ((a, b), (b, a)):
            if x in qa and y not in qa and y in ca and x not in ca and (x in q.head or y in c.head):
                return True
    return False


def _into_output(sentence: str, lex: Lexicon) -> Optional[str]:
    m = _INTO.search(sentence)
    if not m:
        return None
    for tok in _tokenize(m.group(1), lex):
        if tok in lex.roles or tok in OPS:
            return tok
    return None


def _blank_concept(name: str, lex: Lexicon) -> Optional[str]:
    """`customer_email`, `email_text` and `message` all become the same concept."""
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name).replace("_", " ").replace("-", " ").lower()
    words = [w for w in spaced.split() if w not in _BLANK_FILLER]
    if not words:
        return None
    toks = [t for t in _tokenize(" ".join(words), lex) if not t.startswith("§")]
    return toks[-1] if toks else None


def _length_bucket(n: int) -> int:
    return 0 if n < 25 else 1 if n < 60 else 2 if n < 120 else 3


# Matching reads at most this much of a prompt: the start (where the job is said) and the
# end (where people add "Thanks" or a last rule). Anything longer is pasted content, which
# becomes one blank; this also bounds the cost of a crafted 100,000-character body.
MAX_CANON_CHARS = 40_000
_CANON_HEAD = 30_000


def _clip_middle(text: str) -> str:
    if len(text) <= MAX_CANON_CHARS:
        return text
    tail_len = MAX_CANON_CHARS - _CANON_HEAD
    head = text.rfind("\n", _CANON_HEAD - 2_000, _CANON_HEAD)
    if head < 0:
        head = text.rfind(" ", 0, _CANON_HEAD)
    head = head if head > 0 else _CANON_HEAD
    lo = len(text) - tail_len
    tail = text.find("\n", lo, lo + 2_000)
    if tail < 0:
        tail = text.find(" ", lo)
    tail = tail if tail >= 0 else lo
    return text[:head] + f"\n\n {BLANK} \n\n" + text[tail:]


def canonical(body: str, title: str = "", description: str = "", use_case: str = "") -> Canon:
    """Stage 1. Everything matching needs from one prompt, deterministic."""
    lex = lexicon()
    norm = _normalize(body)
    names = list(dict.fromkeys(m.group(1) for m in VAR_RE.finditer(norm)))
    text = _clip_middle(VAR_RE.sub(f" {BLANK} ", norm))
    text, kinds = extract_payload(text)
    text = _TAG_ANY.sub(" ", text).replace("```", " ").replace('"""', " ")
    surface: dict = {}
    words: list = []
    shape_counts: list = []
    sentences: list = []
    clause_starts: list = []          # token indices where a clause starts (every sentence start included)
    numbers: list = []                # (token index, value) of each §num
    n_tokens = 0                      # tokens in `sentences` so far (a running total: no rescans)
    pos: set = set()
    negd: set = set()
    ops_first: frozenset = frozenset()
    ops_all: set = set()
    into_out = None
    opening = 0                       # sentences with words in them so far (the job is said in the first two)
    for raw_sentence in _SENT_SPLIT.split(text):
        s = _strip_rules(raw_sentence.strip())
        if not s.strip():
            continue
        s = _PARTICLE.sub(r"\1 \3 \2", s)
        flags: list = []
        cl_flags: list = []
        num_vals: list = []
        toks = _tokenize(s, lex, surface, words, shape_counts, flags, cl_flags, num_vals)
        quads = list(zip(toks, flags, cl_flags, num_vals))
        if sentences and quads[:1] and quads[0][0] == BLANK and sentences[-1][-1:] == [BLANK]:
            quads = quads[1:]         # a pasted block spread over lines is still one blank
        kept: list = []
        carry = True                  # a sentence starts a clause; a dropped token passes its start on
        for i, (t, ng, st, nv) in enumerate(quads):
            if t == BLANK and i and quads[i - 1][0] == BLANK:
                carry = carry or st
                continue
            kept.append((t, ng, st or carry, nv))
            carry = False
        if not kept:
            continue
        base = n_tokens
        n_tokens += len(kept)
        for j, (t, _, st, nv) in enumerate(kept):
            if st:
                clause_starts.append(base + j)
            if nv is not None:
                numbers.append((base + j, nv))
        pairs = [(t, ng) for t, ng, _, _ in kept]
        sentences.append([t for t, _ in pairs])
        ops = set()
        for t, ng in pairs:
            if t.startswith("§"):
                continue
            (negd if ng else pos).add(t)
            if not ng and t in OPS:
                ops.add(OPS[t])
        ops_all |= ops
        if any(not t.startswith("§") for t, _ in pairs):
            opening += 1
        if opening <= 2:
            if ops and not ops_first:
                ops_first = frozenset(ops)
            into_out = into_out or _into_output(s, lex)
    tokens = [t for s in sentences for t in s]
    neg_only = frozenset(negd - pos)
    blanks = set()
    for nm in names:
        c = _blank_concept(nm, lex)
        if c:
            blanks.add(c)
    for kd in kinds:
        c = _blank_concept(kd, lex)
        if c:
            blanks.add(c)
    formats = frozenset(f for f, _ in shape_counts)
    counts = tuple(sorted({(f, int(c)) for f, c in shape_counts if c is not None and float(c).is_integer()}))
    content = sum(1 for t in tokens if not t.startswith("§"))
    shape = Shape(formats, counts, _length_bucket(content))
    # A rule only one prompt turns around ("don't invent facts") makes another prompt, never an exact copy.
    digest = hashlib.sha256((" ".join(tokens) + ("\x1f¬" + " ".join(sorted(neg_only)) if neg_only else ""))
                            .encode()).hexdigest()
    title_tokens = [t for t in _tokenize(_normalize(title or ""), lex, surface) if not t.startswith("§")]
    desc_tokens = [t for t in _tokenize(_normalize(description or ""), lex, surface) if not t.startswith("§")]
    has_meta = bool(title_tokens or desc_tokens)
    return Canon(tokens=tokens, sentences=sentences, blanks=frozenset(blanks), shape=shape, hash=digest,
                 surface=surface, words=words, meta_tokens=title_tokens + desc_tokens, title_tokens=title_tokens,
                 has_meta=has_meta, use_case=(use_case or "").strip().casefold(), payload_kinds=tuple(kinds),
                 neg_only=neg_only, pos_only=frozenset(pos - negd), ops_first=ops_first,
                 ops_all=frozenset(ops_all), into_out=into_out, clause_starts=tuple(clause_starts),
                 numbers=tuple(numbers))


def canonical_draft(draft: dict) -> Canon:
    return canonical(str(draft.get("body") or ""), str(draft.get("title") or ""),
                     str(draft.get("description") or ""), str(draft.get("use_case") or ""))


# ═════════════════════════════════════════════════════════════════════════
# Stage 2: vectors and the index
# ═════════════════════════════════════════════════════════════════════════

def _unigrams(tokens: Iterable[str]) -> list[str]:
    return [t for t in tokens if not t.startswith("§")]


def _word_terms(canon_sentences: list) -> Counter:
    """Unigrams + within-sentence bigrams (placeholders excluded)."""
    c: Counter = Counter()
    for s in canon_sentences:
        uni = _unigrams(s)
        c.update(uni)
        c.update(f"{a} {b}" for a, b in zip(uni, uni[1:]))
    return c


def _char_terms(words: list) -> Counter:
    c: Counter = Counter()
    for w in words:
        padded = f" {w} "
        L = len(padded)
        for n in (3, 4, 5):
            if L < n:
                continue
            c.update(padded[i:i + n] for i in range(L - n + 1))
    return c


def _shingles(tokens: list) -> frozenset:
    toks = [t for t in tokens if t != NUM]
    if len(toks) < 3:
        return frozenset([tuple(toks)]) if toks else frozenset()
    return frozenset(tuple(toks[i:i + 3]) for i in range(len(toks) - 2))


class Idf:
    """Smoothed IDF from the background corpus; unseen terms get the maximum."""

    def __init__(self, docs: list):
        self.n = len(docs)
        df: Counter = Counter()
        for terms in docs:
            df.update(set(terms))
        self.df = df
        self.max = math.log((self.n + 1) / 1) + 1.0

    def __call__(self, term: str) -> float:
        d = self.df.get(term)
        return self.max if not d else math.log((self.n + 1) / (d + 1)) + 1.0


def _tfidf(counts: Counter, idf: Idf) -> dict:
    v = {t: (1.0 + math.log(c)) * idf(t) for t, c in counts.items() if c > 0}
    norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
    return {t: x / norm for t, x in v.items()}


def _cos(a: dict, b: dict) -> float:
    if len(a) > len(b):
        a, b = b, a
    return sum(x * b.get(t, 0.0) for t, x in a.items())


@dataclass
class Corpus:
    """IDF tables built from public, published prompts only."""
    word: Idf
    char: Idf
    signature: tuple = ()

    @classmethod
    def build(cls, canons: list, signature: tuple = (), counts: Optional[list] = None) -> "Corpus":
        """`counts`: _term_counts(c) for each canon, when the caller has them already."""
        word_docs = []
        char_docs = []
        for i, c in enumerate(canons):
            wc, cc = counts[i] if counts is not None else _term_counts(c)
            terms = set(wc)
            terms.update(c.meta_tokens)
            terms.update(f"{a} {b}" for a, b in zip(c.meta_tokens, c.meta_tokens[1:]))
            word_docs.append(terms)
            char_docs.append(set(cc))
        return cls(Idf(word_docs), Idf(char_docs), signature)


def _term_counts(canon: "Canon") -> tuple:
    """(word uni+bigram counts, char n-gram counts): what both the IDF tables and the vectors need."""
    return _word_terms(canon.sentences), _char_terms(canon.words)


@dataclass
class Entry:
    id: str
    title: str
    description: str
    use_case: str
    author_name: str
    org_id: Optional[str]
    parent_id: Optional[str]
    public: bool                 # visible to everyone (public + published version)
    canon: Canon
    wvec: dict = field(default_factory=dict)
    cvec: dict = field(default_factory=dict)
    mvec: dict = field(default_factory=dict)
    tvec: dict = field(default_factory=dict)
    shingles: frozenset = frozenset()
    terms: frozenset = frozenset()      # unigram terms (for coverage)
    concepts: frozenset = frozenset()
    body: str = ""                      # the text as the viewer may see it (the AI second opinion reads it)


def _vectorize(canon: Canon, corpus: Corpus, counts: Optional[tuple] = None) -> tuple:
    wc, cc = counts if counts is not None else _term_counts(canon)
    wvec = _tfidf(wc, corpus.word)
    cvec = _tfidf(cc, corpus.char)
    meta_counts = Counter(canon.meta_tokens)
    meta_counts.update(f"{a} {b}" for a, b in zip(canon.meta_tokens, canon.meta_tokens[1:]))
    mvec = _tfidf(meta_counts, corpus.word) if meta_counts else {}
    tcounts = Counter(canon.title_tokens)
    tvec = _tfidf(tcounts, corpus.word) if tcounts else {}
    terms = frozenset(_unigrams(canon.tokens))
    concepts = frozenset(t for t in terms if t.startswith("c:"))
    return wvec, cvec, mvec, tvec, _shingles(canon.tokens), terms, concepts


def make_entry(doc: dict, corpus: Corpus, canon: Optional[Canon] = None, counts: Optional[tuple] = None) -> Entry:
    canon = canon or canonical(doc.get("body") or "", doc.get("title") or "", doc.get("description") or "",
                               doc.get("use_case") or "")
    e = Entry(id=str(doc["id"]), title=doc.get("title") or "", description=doc.get("description") or "",
              use_case=doc.get("use_case") or "", author_name=doc.get("author_name") or "",
              org_id=doc.get("org_id"), parent_id=doc.get("parent_id"), public=bool(doc.get("public", True)),
              canon=canon, body=doc.get("body") or "")
    e.wvec, e.cvec, e.mvec, e.tvec, e.shingles, e.terms, e.concepts = _vectorize(canon, corpus, counts)
    return e


@dataclass
class Pool:
    """A searchable set of entries vectorized against one Corpus."""
    corpus: Corpus
    entries: list
    postings: dict
    by_hash: dict
    by_id: dict

    @classmethod
    def build(cls, entries: list, corpus: Corpus) -> "Pool":
        postings: dict = {}
        by_hash: dict = {}
        for i, e in enumerate(entries):
            for t in e.terms | set(e.canon.meta_tokens):
                postings.setdefault(t, []).append(i)
            by_hash.setdefault(e.canon.hash, []).append(i)
        return cls(corpus, entries, postings, by_hash, {e.id: e for e in entries})


def build_pool(docs: list, corpus: Optional[Corpus] = None) -> Pool:
    """Offline helper: docs -> Pool. With no corpus the docs are their own background (seed, eval)."""
    canons = [canonical(d.get("body") or "", d.get("title") or "", d.get("description") or "",
                        d.get("use_case") or "") for d in docs]
    counts = [_term_counts(c) for c in canons]
    corpus = corpus or Corpus.build(canons, counts=counts)
    return Pool.build([make_entry(d, corpus, c, k) for d, c, k in zip(docs, canons, counts)], corpus)


# ═════════════════════════════════════════════════════════════════════════
# Stage 3 + 4: candidates, features, score, levels
# ═════════════════════════════════════════════════════════════════════════

FEATURES = (
    "exact",          # f1  same canonical hash
    "word_cos",       # f2  word uni+bigram TF-IDF cosine
    "char_cos",       # f3  char 3-5-gram cosine (typos, word forms)
    "shingle_jacc",   # f4  3-shingle Jaccard
    "contain_c",      # f5  how much of the existing prompt sits inside the new one
    "contain_q",      #     how much of the new one sits inside the existing prompt
    "blank_jacc",     # f6  blank-concept Jaccard
    "no_blanks",      #     neither has blanks
    "meta_cos",       # f7  q title+description (or text) vs c title+description
    "shape",          # f8  output format agreement minus count mismatch
    "category",       # f9  +1 same category, -1 different, 0 unknown
    "len_ratio",      # f10 |log length ratio|
    "cover_c",        #     IDF mass of c's terms found in q
    "cover_q",        #     IDF mass of q's terms found in c (filled blanks absorbed)
    "concept_jacc",   #     Jaccard of lexicon concepts
    "margin",         #     this candidate's lead over the best other candidate
    "title_cos",      #     q title vs c title (0 when q has none)
    "key_cover",      #     IDF mass of c's title + description found anywhere in q (does q name c's job?)
    "head_q_in_c",    #     q's title + opening found anywhere in c (same job, stated up front?)
    "head_c_in_q",    #     c's title + opening found anywhere in q
    "role_q_head",    #     jobs/outputs q's opening asks for that c never mentions ("translate", "FAQ")
    "role_c_head",    #     jobs/outputs c's opening asks for that q never mentions
    "role_q_all",     #     ... anywhere in q
    "role_c_all",     #     ... anywhere in c
    "role_conflict",  #     both openings ask for a job/output the other never mentions: same topic, other job
)

# Hand-set defaults, used only until similarity_fit.py writes the JSON.
_DEFAULT_MODEL = {
    "features": list(FEATURES),
    "mean": [0.0] * len(FEATURES),
    "std": [1.0] * len(FEATURES),
    "weights": [4.0, 6.0, 2.0, 1.0, 2.0, 1.0, 0.5, 0.2, 2.0, 0.3, 0.5, -0.8, 2.0, 2.0, 1.0, 3.0, 0.5, 0.5, 1.5, 1.5,
                -1.5, -1.5, -0.5, -0.5, -2.0],
    "bias": -8.0,
    "thresholds": {"same": 0.85, "close": 0.6, "related": 0.35},
    "same_gate": {
        "salient_idf": 3.0,
        "features": ["one_sided", "noise", "q_more", "c_more", "q_novel_mass", "c_novel_mass", "q_gap", "c_gap",
                     "q_novel", "c_novel"],
        "mean": [0.0] * 10, "std": [1.0] * 10,
        "weights": [-4.0, 3.0, -3.0, -3.0, -6.0, -6.0, -1.0, -1.0, -1.0, -1.0], "bias": 2.0, "threshold": 0.5,
    },
    "verify": {
        "features": ["word_cos", "cover_c", "cover_q", "head_q_in_c", "head_c_in_q", "role_conflict"],
        "mean": [0.0] * 6, "std": [1.0] * 6, "weights": [4.0, 3.0, 2.0, 2.0, 2.0, -2.0], "bias": -5.0,
    },
}

# Features the verifier reads: does q do the SAME JOB as this candidate? (no rank/margin: a hard
# negative is often the nearest prompt, it just does something else with the same words)
VERIFY_FEATURES = ("word_cos", "char_cos", "cover_c", "cover_q", "head_q_in_c", "head_c_in_q", "meta_cos",
                   "title_cos", "concept_jacc", "len_ratio", "role_q_head", "role_c_head", "role_conflict",
                   "role_q_all", "role_c_all", "contain_c", "contain_q", "shingle_jacc")
LEVEL_RANK = {"same": 0, "close": 1, "related": 2}


@dataclass
class Model:
    features: list
    mean: list
    std: list
    weights: list
    bias: float
    thresholds: dict
    same_gate: dict
    verify: dict = field(default_factory=lambda: dict(_DEFAULT_MODEL["verify"]))
    meta: dict = field(default_factory=dict)
    reword_gate: Optional[dict] = None      # None: no reword gate (an older weights file)

    @classmethod
    def from_dict(cls, d: dict) -> "Model":
        feats = list(d.get("features") or FEATURES)
        return cls(feats, list(d.get("mean") or [0.0] * len(feats)), list(d.get("std") or [1.0] * len(feats)),
                   list(d["weights"]), float(d["bias"]), dict(d["thresholds"]),
                   {**_DEFAULT_MODEL["same_gate"], **(d.get("same_gate") or {})},
                   dict(d.get("verify") or _DEFAULT_MODEL["verify"]),
                   {k: v for k, v in d.items() if k not in ("features", "mean", "std", "weights", "bias",
                                                             "thresholds", "same_gate", "verify", "reword_gate")},
                   dict(d["reword_gate"]) if d.get("reword_gate") else None)

    def to_dict(self) -> dict:
        out = {"features": self.features, "mean": self.mean, "std": self.std, "weights": self.weights,
               "bias": self.bias, "thresholds": self.thresholds, "same_gate": self.same_gate,
               "verify": self.verify}
        if self.reword_gate:
            out["reword_gate"] = self.reword_gate
        return {**out, **self.meta}

    @staticmethod
    def _logit(spec: dict, values: dict) -> float:
        z = float(spec.get("bias", 0.0))
        for name, w, mu, sd in zip(spec.get("features") or [], spec.get("weights") or [], spec.get("mean") or [],
                                   spec.get("std") or []):
            z += w * ((values.get(name, 0.0) - mu) / (sd or 1.0))
        z = max(-40.0, min(40.0, z))
        return 1.0 / (1.0 + math.exp(-z))

    def verify_prob(self, feats: dict) -> float:
        """Does the query do the same job as this candidate (rather than another job on the same topic)?"""
        return self._logit(self.verify, feats)

    def gate_prob(self, gfeats: dict) -> float:
        return self._logit(self.same_gate, gfeats)

    def reword_prob(self, gfeats: dict) -> float:
        """Is this a rewording with nothing added or dropped (1.0 when the model has no reword gate)?"""
        return self._logit(self.reword_gate, gfeats) if self.reword_gate else 1.0

    def score(self, feats: dict) -> float:
        z = self.bias
        for name, w, mu, sd in zip(self.features, self.weights, self.mean, self.std):
            z += w * ((feats.get(name, 0.0) - mu) / (sd or 1.0))
        z = max(-40.0, min(40.0, z))
        return 1.0 / (1.0 + math.exp(-z))


_MODEL: Optional[Model] = None


def model() -> Model:
    global _MODEL
    if _MODEL is None:
        try:
            _MODEL = Model.from_dict(json.loads(WEIGHTS_PATH.read_text()))
        except (OSError, ValueError, KeyError):
            _MODEL = Model.from_dict(_DEFAULT_MODEL)
    return _MODEL


def set_model(m: Optional[Model]) -> None:
    """Swap the scoring model (the fit script and tests); None reloads the JSON."""
    global _MODEL
    _MODEL = m


@dataclass
class Query:
    canon: Canon
    wvec: dict
    cvec: dict
    mvec: dict
    tvec: dict
    shingles: frozenset
    terms: frozenset
    concepts: frozenset


def make_query(canon: Canon, corpus: Corpus) -> Query:
    wvec, cvec, mvec, tvec, sh, terms, concepts = _vectorize(canon, corpus)
    if not canon.has_meta:
        # No title or description: compare the text itself against theirs (f7).
        mvec = wvec
    return Query(canon, wvec, cvec, mvec, tvec, sh, terms, concepts)


def _jacc(a: frozenset, b: frozenset) -> float:
    u = len(a | b)
    return len(a & b) / u if u else 0.0


def _absorbed(q_tokens: list, c_tokens: list) -> set:
    """Query positions that fill one of the candidate's blanks ("for {{client}}" vs "for Northwind").

    Only a blank the query left unfilled can absorb words: one the query matched with its own
    blank (or pasted block) is taken, so text next to it is an addition, not a fill.
    """
    sm = difflib.SequenceMatcher(None, c_tokens, q_tokens, autojunk=False)
    ops = sm.get_opcodes()
    matched = set()
    for op, i1, i2, j1, j2 in ops:
        if op == "equal":
            matched.update(i for i in range(i1, i2) if c_tokens[i] == BLANK)
    free = {i for i, t in enumerate(c_tokens) if t == BLANK and i not in matched}
    out: set = set()
    for op, i1, i2, j1, j2 in ops:
        if j2 <= j1:
            continue
        if op == "replace" and any(i in free for i in range(i1, i2)):
            out.update(range(j1, j2))
        elif op == "insert" and ((i1 - 1) in free or i1 in free):
            out.update(range(j1, j2))
    return out


def _coverage(src_terms: Iterable[str], other: frozenset, corpus: Corpus) -> float:
    tot = cov = 0.0
    for t in sorted(src_terms):     # sorted: float sums must not depend on set order (hash seed)
        w = corpus.word(t)
        tot += w
        if t in other:
            cov += w
    return cov / tot if tot else 0.0


def _shape_agreement(a: Shape, b: Shape) -> float:
    u = a.formats | b.formats
    if not u:
        return 1.0
    s = len(a.formats & b.formats) / len(u)
    for f in a.formats & b.formats:
        ca, cb = a.count_of(f), b.count_of(f)
        if ca is not None and cb is not None and ca != cb:
            s -= 0.5
    return s


def _category(q: Canon, c: Entry) -> float:
    if not q.use_case or not c.use_case:
        return 0.0
    return 1.0 if q.use_case == c.use_case.strip().casefold() else -1.0


def _prelim(q: Query, e: Entry) -> float:
    """Weight-free first-pass score used to pick who gets fully scored (and the margin)."""
    return _cos(q.wvec, e.wvec) + 0.35 * _cos(q.mvec, e.mvec) + 0.25 * _cos(q.cvec, e.cvec)


@dataclass
class Pair:
    entry: Entry
    feats: dict
    gate: dict
    score: float = 0.0          # match score: how alike (ranking)
    verify: float = 0.0         # same-job probability (levels)
    level: Optional[str] = None
    note: Optional[str] = None  # the AI second opinion's plain sentence (Save only)
    judged: Optional[str] = None  # its verdict: "yes" | "partly" | "no"


def pair_features(q: Query, e: Entry, corpus: Corpus, margin: float) -> tuple[dict, dict]:
    """(model features, same-gate facts) for one (query, candidate) pair."""
    qc, cc = q.canon, e.canon
    inter = len(q.shingles & e.shingles)
    c_uni = _unigrams(cc.tokens)
    # Terms of q that only fill c's blanks don't count as "yours also".
    absorbed_pos = _absorbed(qc.tokens, cc.tokens) if BLANK in cc.tokens else set()
    q_core = [t for i, t in enumerate(qc.tokens) if not t.startswith("§") and i not in absorbed_pos]
    feats = {
        "exact": 1.0 if qc.hash == cc.hash and qc.tokens else 0.0,
        "word_cos": _cos(q.wvec, e.wvec),
        "char_cos": _cos(q.cvec, e.cvec),
        "shingle_jacc": inter / (len(q.shingles | e.shingles) or 1),
        "contain_c": inter / (len(e.shingles) or 1),
        "contain_q": inter / (len(q.shingles) or 1),
        "blank_jacc": _jacc(qc.blanks, cc.blanks),
        "no_blanks": 1.0 if not qc.blanks and not cc.blanks else 0.0,
        "meta_cos": _cos(q.mvec, e.mvec),
        "shape": _shape_agreement(qc.shape, cc.shape),
        "category": _category(qc, e),
        "len_ratio": abs(math.log((len(q_core) + 1) / (len(c_uni) + 1))),
        "cover_c": _coverage(set(c_uni), q.terms, corpus),
        "cover_q": _coverage(set(q_core), e.terms, corpus),
        "concept_jacc": _jacc(q.concepts, e.concepts),
        "margin": margin,
        "title_cos": _cos(q.tvec, e.tvec) if q.tvec else 0.0,
        "key_cover": _coverage(set(cc.meta_tokens), q.terms | set(qc.meta_tokens), corpus),
        "head_q_in_c": _coverage(qc.head, e.terms | set(cc.meta_tokens), corpus),
        "head_c_in_q": _coverage(cc.head, q.terms | set(qc.meta_tokens), corpus),
    }
    roles = lexicon().roles
    q_all, c_all = q.terms | set(qc.meta_tokens), e.terms | set(cc.meta_tokens)
    feats["role_q_head"] = float(sum(1 for t in qc.head if t in roles and t not in c_all))
    feats["role_c_head"] = float(sum(1 for t in cc.head if t in roles and t not in q_all))
    feats["role_q_all"] = float(sum(1 for t in q_all if t in roles and t not in c_all))
    feats["role_c_all"] = float(sum(1 for t in c_all if t in roles and t not in q_all))
    feats["role_conflict"] = min(feats["role_q_head"], feats["role_c_head"])
    # Hard limits on the level (level_for), not model inputs: another job, or a rule turned around.
    feats["op_conflict"] = 1.0 if _op_conflict(qc, cc) else 0.0
    # Only between near-copies: a reworded prompt often says the same rule both ways ("don't touch
    # the layout" / "leave the layout as it is"); a copy with one "don't" added or dropped doesn't.
    feats["neg_flip"] = float(len(_neg_flips(qc, cc))) if feats["shingle_jacc"] >= NEG_FLIP_MIN_OVERLAP else 0.0
    gate = _gate_facts(qc, cc, q_core, absorbed_pos, q.terms, e.terms, corpus)
    return feats, gate


NEG_FLIP_MIN_OVERLAP = 0.6     # 3-word-shingle Jaccard above which two prompts are copies of each other


def _neg_flips(q: Canon, c: Canon) -> set:
    """Content words one prompt only ever says NOT to do and the other only ever says to do."""
    return {t for t in (q.neg_only & c.pos_only) | (c.neg_only & q.pos_only) if t not in _NEG_WEAK}


def _requirement(token: str) -> bool:
    """Does this token make its clause a requirement on the output (format, length, audience, tone,
    one more deliverable)? Output formats, things made and jobs done, plus the lexicon's list."""
    lex = lexicon()
    return token in lex.requirement or token in lex.shapes or token in lex.roles


def _gate_facts(qc: Canon, cc: Canon, q_core: list, absorbed_pos: set, q_terms: frozenset,
                c_terms: frozenset, corpus: Corpus) -> dict:
    """Raw facts the same-gate reads; cutoffs are applied in same_gate_ok so the fit can tune them.

    q_extra / c_extra: (term, idf) the other side lacks (blank fills on q's side excluded).
    q_sents / c_sents: per sentence, (idf, found on the other side) for each distinct term.
    """
    q_extra = sorted({(t, round(corpus.word(t), 4)) for t in q_core if t not in c_terms})
    c_extra = sorted({(t, round(corpus.word(t), 4)) for t in _unigrams(cc.tokens) if t not in q_terms})

    def sents(sentences: list, other: frozenset, skip_pos: Optional[set] = None) -> list:
        out = []
        pos = 0
        for s in sentences:
            idx = range(pos, pos + len(s))
            pos += len(s)
            terms = {t for t, p in zip(s, idx) if not t.startswith("§") and (skip_pos is None or p not in skip_pos)}
            if terms:
                out.append(sorted((round(corpus.word(t), 4), t in other) for t in terms))
        return out

    idf: dict = {}

    def w(t: str) -> float:
        v = idf.get(t)
        if v is None:
            v = idf[t] = round(corpus.word(t), 4)
        return v

    def clauses(canon: Canon, other: frozenset, skip_pos: Optional[set] = None) -> tuple[list, list]:
        """Per clause: ((idf, found on the other side) per distinct term, a requirement word in it?),
        and per clause its terms with their IDF (for lining the two prompts' clauses up). At most
        MAX_GATE_CLAUSES clauses (real prompts have a few dozen): the cost stays bounded."""
        out, sets = [], []
        toks = canon.tokens
        for a, b in canon.clauses():
            keep = [p for p in range(a, b) if skip_pos is None or p not in skip_pos]
            terms = {toks[p] for p in keep if not toks[p].startswith("§")}
            if not terms:
                continue
            req = any(toks[p] == NUM or _requirement(toks[p]) for p in keep)
            out.append((sorted((w(t), t in other) for t in terms), req))
            sets.append(tuple(sorted((t, w(t)) for t in terms)))
            if len(out) >= MAX_GATE_CLAUSES:
                break
        return out, sets

    skip = absorbed_pos or None
    q_cl, q_sets = clauses(qc, c_terms, skip)
    c_cl, c_sets = clauses(cc, q_terms)
    q_req = {t for t in q_core if _requirement(t)}
    c_req = {t for t in _unigrams(cc.tokens) if _requirement(t)}
    return {"q_extra": q_extra, "c_extra": c_extra,
            "q_len": len(q_core), "c_len": len(_unigrams(cc.tokens)),
            "q_req_only": sorted(t for t in q_req if t not in c_terms),
            "c_req_only": sorted(t for t in c_req if t not in q_terms),
            "q_sents": sents(qc.sentences, c_terms, absorbed_pos), "c_sents": sents(cc.sentences, q_terms),
            "q_clauses": q_cl, "c_clauses": c_cl, "q_clause_sets": q_sets, "c_clause_sets": c_sets,
            "q_nums": sorted({v for p, v in qc.numbers if p not in absorbed_pos}),
            "c_nums": sorted({v for _, v in cc.numbers})}


def gate_extras(gate: dict, side: str, cutoff: float) -> list:
    """Salient terms only one side has: rarer than `cutoff` in the background corpus."""
    return [t for t, w in gate[f"{side}_extra"] if w >= cutoff]


def _sentence_cover(sents: list, cutoff: float, min_terms: int) -> list:
    """(coverage, salient mass) per sentence with at least `min_terms` salient terms."""
    out = []
    for sent in sents:
        sal = [(w, found) for w, found in sent if w >= cutoff]
        if len(sal) < min_terms:
            continue
        tot = sum(w for w, _ in sal)
        out.append((sum(w for w, found in sal if found) / tot, tot))
    return out


def gate_features(feats: dict, gate: dict) -> dict:
    """Is the overlap a rewording of the same job, or the same text with something added or dropped?

    A paraphrase leaves a little of each side unmatched, about equally; a filled-in
    copy leaves almost nothing; an extended or trimmed copy leaves one side's extra
    concentrated in whole sentences the other side doesn't have.
    """
    cq, cc = feats["cover_q"], feats["cover_c"]
    out = {"one_sided": abs(cc - cq), "noise": min(1.0 - cq, 1.0 - cc),
           "q_more": max(0.0, cc - cq), "c_more": max(0.0, cq - cc)}
    for side in ("q", "c"):
        covs = _sentence_cover(gate[f"{side}_sents"], 2.5, 3)
        total = sum(sum(w for w, _ in s) for s in gate[f"{side}_sents"]) or 1.0
        out[f"{side}_novel_mass"] = sum(m for cov, m in covs if cov < 0.35) / total
        if len(covs) >= 2:
            i = min(range(len(covs)), key=lambda j: covs[j][0])
            rest = [c for j, c in enumerate(covs) if j != i]
            rest_cov = sum(c * m for c, m in rest) / (sum(m for _, m in rest) or 1.0)
            out[f"{side}_gap"] = max(0.0, rest_cov - covs[i][0])
        else:
            out[f"{side}_gap"] = 0.0
        out[f"{side}_novel"] = float(sum(1 for cov, _ in covs if cov <= 0.3))
    out["role_q_all"] = feats.get("role_q_all", 0.0)
    out["role_c_all"] = feats.get("role_c_all", 0.0)
    # "copied and extended" (plan f5): the other prompt sits inside this one and this one has more
    out["contain_c"] = feats.get("contain_c", 0.0)
    out["contain_q"] = feats.get("contain_q", 0.0)
    out["extended_by_q"] = feats.get("contain_c", 0.0) * out["q_more"]
    out["trimmed_by_q"] = feats.get("contain_q", 0.0) * out["c_more"]
    # Clauses one side has and the other doesn't cover: a requirement added or dropped inside a
    # sentence ("..., and add a video version"), which whole-sentence coverage averages away.
    for side in ("q", "c"):
        unc = _uncovered_clauses(gate.get(f"{side}_clauses") or [])
        out[f"{side}_unc"] = float(len(unc))
        out[f"{side}_unc_req"] = float(sum(1 for _, _, req in unc if req))
        total = sum(w for terms, _ in gate.get(f"{side}_clauses") or [] for w, _ in terms if w >= CLAUSE_SALIENT)
        out[f"{side}_unc_mass"] = sum(m for _, m, _ in unc) / (total or 1.0)
    out["unc_diff"] = out["q_unc"] - out["c_unc"]
    out["unc_req_diff"] = out["q_unc_req"] - out["c_unc_req"]
    out["unc_asym"] = abs(out["unc_diff"])
    out["unc_req_asym"] = abs(out["unc_req_diff"])
    out["unc_mass_asym"] = abs(out["q_unc_mass"] - out["c_unc_mass"])
    qn, cn = set(gate.get("q_nums") or ()), set(gate.get("c_nums") or ())
    out["num_q_only"] = float(len(qn - cn))
    out["num_c_only"] = float(len(cn - qn))
    # A requirement word (format, length, audience, one more deliverable) only one side uses.
    out["req_q_only"] = float(len(gate.get("q_req_only") or ()))
    out["req_c_only"] = float(len(gate.get("c_req_only") or ()))
    out["req_asym"] = abs(out["req_q_only"] - out["req_c_only"])
    # Longer or shorter than the other prompt (signed): an added requirement makes it longer.
    out["len_signed"] = math.log((gate.get("q_len", 0) + 1) / (gate.get("c_len", 0) + 1))
    out["len_abs"] = abs(out["len_signed"])
    out.update(_clause_alignment(gate))
    return out


CLAUSE_ALIGN = 0.1     # weighted Jaccard two clauses need to be counted as saying the same thing
MAX_GATE_CLAUSES = 200  # clauses per side the same-gate reads (bounds the cost of crafted text)


def _clause_alignment(gate: dict) -> dict:
    """Line each clause of one prompt up with at most one clause of the other (most alike first).
    A reworded prompt has a partner for nearly every clause on both sides; an added requirement is a
    clause left over on one side only, even when it reuses the other prompt's words ("also check my
    other pages for the same problem"). Cached in `gate` (it is asked for once per pair)."""
    hit = gate.get("_align")
    if hit is not None:
        return hit
    qa = [dict(s) for s in gate.get("q_clause_sets") or ()]
    ca = [dict(s) for s in gate.get("c_clause_sets") or ()]
    cand = []
    for i, a in enumerate(qa):
        for j, b in enumerate(ca):
            inter = sum(w for t, w in a.items() if t in b)
            if not inter:
                continue
            union = sum(a.values()) + sum(b.values()) - inter
            sim = inter / union if union else 0.0
            if sim >= CLAUSE_ALIGN:
                cand.append((-sim, i, j))
    cand.sort()
    free_q, free_c = set(range(len(qa))), set(range(len(ca)))
    for _, i, j in cand:
        if i in free_q and j in free_c:
            free_q.discard(i)
            free_c.discard(j)
    q_tot = sum(sum(a.values()) for a in qa) or 1.0
    c_tot = sum(sum(b.values()) for b in ca) or 1.0
    qm = sum(sum(qa[i].values()) for i in free_q) / q_tot
    cm = sum(sum(ca[j].values()) for j in free_c) / c_tot
    out = {"al_q": float(len(free_q)), "al_c": float(len(free_c)), "al_qm": qm, "al_cm": cm,
           "al_asym": float(abs(len(free_q) - len(free_c))), "al_masym": abs(qm - cm),
           "al_ndiff": float(abs(len(qa) - len(ca)))}
    gate["_align"] = out
    return out


# A clause is "uncovered" when the other prompt has less than CLAUSE_UNCOVERED of the IDF mass of its
# salient terms (IDF >= CLAUSE_SALIENT), counting clauses with at least CLAUSE_MIN_TERMS of them.
CLAUSE_SALIENT = 2.5
CLAUSE_MIN_TERMS = 2
CLAUSE_UNCOVERED = 0.34


def _uncovered_clauses(clauses: list) -> list:
    """(coverage, salient mass, requirement?) of each clause the other side doesn't cover."""
    out = []
    for terms, req in clauses:
        sal = [(w, found) for w, found in terms if w >= CLAUSE_SALIENT]
        if len(sal) < CLAUSE_MIN_TERMS:
            continue
        tot = sum(w for w, _ in sal)
        cov = sum(w for w, found in sal if found) / tot
        if cov < CLAUSE_UNCOVERED:
            out.append((cov, tot, req))
    return out


def same_gate_ok(gate: dict, feats: dict, m: Optional[Model] = None) -> bool:
    """The salient-extra rule, learned: "same" only when neither side adds or drops a requirement.

    Two learned checks, both must pass: the same-gate (a copy with something added or cut) and
    the reword gate (a REWORDED prompt with a requirement added or dropped: a clause left over on
    one side, a requirement word or number only one side has, one side longer)."""
    m = m or model()
    gf = gate_features(feats, gate)
    if m.gate_prob(gf) < float(m.same_gate.get("threshold", 0.5)):
        return False
    return m.reword_prob(gf) >= float((m.reword_gate or {}).get("threshold", 0.0))


def level_for(score: float, feats: dict, gate: dict, m: Optional[Model] = None,
              verify: Optional[float] = None) -> Optional[str]:
    """Levels (plan §1 Stage 4). `score` ranks and decides "related"; the same-job verifier decides
    "close"; "same" also needs the same-gate (nothing added or dropped on either side).

    Two hard limits come before the models: a different job (op_conflict: "remove the gallery"
    vs "add a gallery", "translate the email" vs "summarize the email") is never more than
    "related", and a rule one prompt turns around (neg_flip: "invent facts if you need to" vs
    "don't invent facts") is never "same"."""
    m = m or model()
    t = m.thresholds
    if feats.get("exact"):
        return "same"
    if score < t["related"]:
        return None
    if feats.get("op_conflict"):
        return "related"
    v = m.verify_prob(feats) if verify is None else verify
    if v >= t["same"] and not feats.get("neg_flip") and same_gate_ok(gate, feats, m):
        return "same"
    if v >= t["close"]:
        return "close"
    return "related"


def order(pairs: list) -> list:
    """What people see: same before close before related, then by score."""
    return sorted(pairs, key=lambda p: (LEVEL_RANK.get(p.level, 9), -p.score, p.entry.id))


FULL_SCAN_MAX = 3_000     # up to this many visible prompts, every one is a candidate (no postings shortcut)


def candidates(q: Query, pools: list, allow=None, exclude: frozenset = frozenset()) -> list:
    """Stage 3: (entry, prelim) for the top CANDIDATES by word cosine, best first.

    A small library (FULL_SCAN_MAX) is scanned whole: the postings of the 12 rarest query
    terms can all come from leftover pasted text, and then the right prompt is never looked at."""
    corpus = pools[0].corpus
    full = sum(len(p.entries) for p in pools) <= FULL_SCAN_MAX
    terms: list = []
    if not full:
        known = [t for t in set(q.terms) | set(q.canon.meta_tokens) if any(t in p.postings for p in pools)]
        terms = sorted(known, key=lambda t: (-corpus.word(t), t))[:CANDIDATE_TERMS]
    seen: dict = {}
    for pool in pools:
        idxs: set = set(range(len(pool.entries))) if full else set()
        for t in terms:
            idxs.update(pool.postings.get(t, ()))
        idxs.update(pool.by_hash.get(q.canon.hash, ()))
        for i in idxs:
            e = pool.entries[i]
            if e.id in exclude or e.id in seen or (allow is not None and not allow(e)):
                continue
            seen[e.id] = e
    scored = [(e, _cos(q.wvec, e.wvec)) for e in seen.values()]
    scored.sort(key=lambda x: (-x[1], x[0].id))
    return scored[:CANDIDATES]


def score_query(q: Query, pools: list, allow=None, exclude: frozenset = frozenset(),
                m: Optional[Model] = None, rescore: int = RESCORE) -> list:
    """Stages 3-4 for one query: scored Pairs, best first (levels set, None when below related)."""
    m = m or model()
    corpus = pools[0].corpus
    cands = candidates(q, pools, allow, exclude)
    if not cands:
        return []
    pre = [(e, _prelim(q, e)) for e, _ in cands]
    pre.sort(key=lambda x: (-x[1], x[0].id))
    top = pre[:rescore]
    pairs = []
    for idx, (e, p) in enumerate(top):
        best_other = max((x[1] for j, x in enumerate(pre) if j != idx), default=0.0)
        feats, gate = pair_features(q, e, corpus, p - best_other)
        pr = Pair(e, feats, gate)
        pr.score = m.score(feats)
        pr.verify = m.verify_prob(feats)
        pr.level = level_for(pr.score, feats, gate, m, pr.verify)
        pairs.append(pr)
    pairs.sort(key=lambda x: (-x.score, x.entry.id))
    return pairs


# ── plain-language explanation ───────────────────────────────────────────

# Words that are rare enough to rank but say nothing about what a prompt asks for ("made", "came",
# "bring", "hand"): never shown in "Both / Yours also / Theirs also". Display only; matching still
# counts them.
_DISPLAY_FILLER_WORDS = frozenset("""
make makes made making come comes came coming bring brings brought bringing hand hands handed handing
take takes took taken taking give gives gave given giving put puts putting get gets got gotten getting
go goes went gone going use uses used using need needs needed want wants wanted let lets letting
keep keeps kept keeping see sees saw seen seeing look looks looked looking say says said saying
tell tells told telling try tries tried trying do does did done doing happen happens happened
seem seems seemed feel feels felt think thinks thought know knows knew known guess
thing things stuff way ways lot lots bit bits kind sort sure able actual actually real really
whole around else right quite rather pretty nice good great well back away along okay ok
""".split())


@lru_cache(maxsize=1)
def _display_filler() -> frozenset:
    lex = lexicon()
    return frozenset(_DISPLAY_FILLER_WORDS | {lex.stem(_norm_word(w, lex.spelling)) for w in _DISPLAY_FILLER_WORDS})


def _labels(tokens: Iterable[str], corpus: Corpus, surface: dict, limit: int = 4, min_idf: float = 1.8) -> list:
    skip = _display_filler()
    ranked = sorted({t for t in tokens if not t.startswith("§") and corpus.word(t) >= min_idf and t not in skip
                     and str(surface.get(t, "")).lower() not in skip},
                    key=lambda t: (-corpus.word(t) * (1.4 if t.startswith("c:") else 1.0), t))
    out: list = []
    for t in ranked:
        lab = label_of(t, surface)
        if lab and lab not in out:
            out.append(lab)
        if len(out) >= limit:
            break
    return out


def explain(q: Canon, e: Entry, corpus: Corpus, gate: Optional[dict] = None, feats: Optional[dict] = None) -> dict:
    q_terms = set(_unigrams(q.tokens))
    c_terms = set(_unigrams(e.canon.tokens))
    surface = {**e.canon.surface, **q.surface}
    shared = _labels(q_terms & c_terms, corpus, surface)
    if gate is not None:
        cutoff = float(model().same_gate.get("salient_idf", 3.0))
        yours = _labels(gate_extras(gate, "q", cutoff), corpus, q.surface, min_idf=0)
        theirs = _labels(gate_extras(gate, "c", cutoff), corpus, e.canon.surface, min_idf=0)
    else:
        yours = _labels(q_terms - c_terms, corpus, q.surface)
        theirs = _labels(c_terms - q_terms, corpus, e.canon.surface)
    note = None
    flips = sorted(_neg_flips(q, e.canon)) if feats and feats.get("neg_flip") else []
    if flips:
        word = label_of(flips[0], surface)
        note = f"Yours says the opposite of this one about “{word}”."
    for fmt in sorted(q.shape.formats & e.canon.shape.formats) if note is None else ():
        a, b = q.shape.count_of(fmt), e.canon.shape.count_of(fmt)
        if a is not None and b is not None and a != b:
            word = {"bullets": "bullets", "table": "rows", "steps": "steps", "list": "items"}.get(fmt, fmt)
            note = f"Yours asks for {a} {word}; this one asks for {b}."
            break
    return {"shared": shared, "yours_only": yours, "theirs_only": theirs, "note": note}


def _match_dict(pr: Pair, q: Canon, corpus: Corpus, viewer_org: Optional[str], relation: Optional[str]) -> dict:
    e = pr.entry
    ex = explain(q, e, corpus, pr.gate, pr.feats)
    # The AI second opinion's sentence (Save only) replaces the term lists it describes better.
    terms_shown = pr.level != "same" and not pr.note
    out = {"id": e.id, "title": e.title, "description": e.description, "use_case": e.use_case,
           "author_name": e.author_name, "owned": bool(viewer_org and e.org_id == viewer_org),
           "copy_of_yours": relation is not None, "level": pr.level,
           "exact": bool((pr.feats or {}).get("exact")), "score": round(pr.score, 4),
           "shared": ex["shared"], "yours_only": ex["yours_only"] if terms_shown else [],
           "theirs_only": ex["theirs_only"] if terms_shown else []}
    note = pr.note or ex["note"]
    if relation == "parent":
        note = "Yours was copied from this one."
    elif relation == "child":
        note = "This one is a copy of yours."
    if note:
        out["note"] = note
    return out


def rank(q_canon: Canon, pools: list, k: int, viewer_org: Optional[str] = None, allow=None,
         exclude: frozenset = frozenset(), relations: Optional[dict] = None, review=None) -> list:
    """Matches (contract dicts) for a canonical query, best first, at most k, level >= related.

    `review(pairs)`: an optional second look (the AI second opinion on Save) that may change the
    levels and notes of the already scored, already visibility-filtered pairs before the top k
    are taken. It never adds a candidate.
    """
    if q_canon.content_len < MIN_CONTENT_TOKENS or not pools:
        return []
    corpus = pools[0].corpus
    q = make_query(q_canon, corpus)
    pairs = order([p for p in score_query(q, pools, allow, exclude) if p.level])
    if review is not None and pairs:
        review(pairs)
        pairs = order([p for p in pairs if p.level])
    return [_match_dict(p, q_canon, corpus, viewer_org, (relations or {}).get(p.entry.id)) for p in pairs[:k]]


# ═════════════════════════════════════════════════════════════════════════
# Seed hygiene (offline): no two library prompts may be close or same
# ═════════════════════════════════════════════════════════════════════════

def seed_docs(items: list) -> list:
    return [{"id": str(it.get("title") or f"#{i}"), "title": str(it.get("title") or ""),
             "description": str(it.get("description") or "").strip(), "use_case": str(it.get("use_case") or ""),
             "body": str(it.get("body") or ""), "author_name": "Arceo Library", "public": True}
            for i, it in enumerate(items) if isinstance(it, dict) and it.get("body")]


def seed_near_duplicates(items: list, levels: tuple = ("same", "close")) -> list:
    """Pairs of seed prompts that match each other at `levels`. Offline: the index is built from `items`.

    Returns [{"a": title, "b": title, "level", "score", "shared": [...]}], one per unordered pair,
    strongest direction kept, sorted by score.
    """
    docs = seed_docs(items)
    if len(docs) < 2:
        return []
    pool = build_pool(docs)
    found: dict = {}
    for e in pool.entries:
        q = make_query(e.canon, pool.corpus)
        for pr in score_query(q, [pool], exclude=frozenset([e.id]), rescore=6):
            if pr.level in levels:
                key = tuple(sorted((e.id, pr.entry.id)))
                prev = found.get(key)
                if prev is None or pr.score > prev["score"]:
                    found[key] = {"a": key[0], "b": key[1], "level": pr.level, "score": round(pr.score, 4),
                                  "shared": explain(e.canon, pr.entry, pool.corpus)["shared"]}
    return sorted(found.values(), key=lambda d: (-d["score"], d["a"], d["b"]))


# ═════════════════════════════════════════════════════════════════════════
# The live index (database-backed, per process)
# ═════════════════════════════════════════════════════════════════════════

_PUBLIC_SQL = (
    "SELECT p.id, p.org_id, p.author_name, p.description, p.use_case, p.parent_id, "
    "COALESCE(v.title, p.title) AS title, COALESCE(v.body, p.body) AS body "
    "FROM prompts p LEFT JOIN prompt_versions v ON v.prompt_id = p.id AND v.version = p.published_version "
    "WHERE p.visibility = 'public' AND p.status = 'published'"
)
_ORG_SQL = ("SELECT id, org_id, author_name, title, description, use_case, parent_id, body "
            "FROM prompts WHERE org_id = %s")


class _Live:
    """The in-process index. `lock` only guards these fields and is never held while an index
    is built, so a slow rebuild can't stall every search, save and match in the process."""

    def __init__(self):
        self.lock = threading.RLock()
        self.public_build = threading.Lock()    # one public rebuild at a time (others wait for it)
        self.public: Optional[Pool] = None
        self.public_sig: Optional[tuple] = None
        self.orgs: "OrderedDict[str, tuple]" = OrderedDict()   # org_id -> (sig, corpus_sig, Pool)

    def clear(self) -> None:
        with self.lock:
            self.public = None
            self.public_sig = None
            self.orgs.clear()


_LIVE = _Live()

# Canonical forms of the prompts the live index was built from, by content. A rebuild (any
# public prompt changes, anywhere) re-reads every prompt but only canonicalizes new text.
CANON_CACHE_SIZE = 4_096
_CANON_CACHE: "OrderedDict[str, Canon]" = OrderedDict()
_CANON_LOCK = threading.Lock()


def _canonical_cached(body: str, title: str, description: str, use_case: str) -> Canon:
    key = hashlib.sha256("\x1f".join((body, title, description, use_case)).encode()).hexdigest()
    with _CANON_LOCK:
        hit = _CANON_CACHE.get(key)
        if hit is not None:
            _CANON_CACHE.move_to_end(key)
            return hit
    canon = canonical(body, title, description, use_case)
    with _CANON_LOCK:
        _CANON_CACHE[key] = canon
        while len(_CANON_CACHE) > CANON_CACHE_SIZE:
            _CANON_CACHE.popitem(last=False)
    return canon


def _doc_canon(d: dict) -> Canon:
    return _canonical_cached(d.get("body") or "", d.get("title") or "", d.get("description") or "",
                             d.get("use_case") or "")


def _signature(conn, where: str, args: tuple) -> tuple:
    row = conn.execute(f"SELECT COUNT(*) AS n, MAX(updated_at) AS u, COALESCE(SUM(published_version), 0) AS v "
                       f"FROM prompts WHERE {where}", args).fetchone()
    return (row["n"], str(row["u"]), row["v"])


def _public_pool(conn) -> Pool:
    sig = _signature(conn, "visibility = 'public' AND status = 'published'", ())
    with _LIVE.lock:
        if _LIVE.public is not None and _LIVE.public_sig == sig:
            return _LIVE.public
    with _LIVE.public_build:
        with _LIVE.lock:   # another request may have just built it
            if _LIVE.public is not None and _LIVE.public_sig == sig:
                return _LIVE.public
        rows = conn.execute(_PUBLIC_SQL).fetchall()
        docs = [{**dict(r), "public": True} for r in rows]
        canons = [_doc_canon(d) for d in docs]
        counts = [_term_counts(c) for c in canons]
        corpus = Corpus.build(canons, sig, counts)
        pool = Pool.build([make_entry(d, corpus, c, k) for d, c, k in zip(docs, canons, counts)], corpus)
        with _LIVE.lock:
            _LIVE.public, _LIVE.public_sig = pool, sig
            _LIVE.orgs.clear()          # org vectors used the old IDF
        return pool


def _org_pool(conn, org_id: str, corpus: Corpus) -> Pool:
    sig = _signature(conn, "org_id = %s", (org_id,))
    with _LIVE.lock:
        hit = _LIVE.orgs.get(org_id)
        if hit and hit[0] == sig and hit[1] == corpus.signature:
            _LIVE.orgs.move_to_end(org_id)
            return hit[2]
    rows = conn.execute(_ORG_SQL, (org_id,)).fetchall()
    entries = []
    for r in rows:
        d = {**dict(r), "public": False}
        entries.append(make_entry(d, corpus, _doc_canon(d)))
    pool = Pool.build(entries, corpus)
    with _LIVE.lock:
        _LIVE.orgs[org_id] = (sig, corpus.signature, pool)
        _LIVE.orgs.move_to_end(org_id)
        while len(_LIVE.orgs) > ORG_CACHE_SIZE:
            _LIVE.orgs.popitem(last=False)
    return pool


def _view(org_id: Optional[str], public_only: bool) -> tuple:
    """(pools, allow) for a viewer: their org's working prompts, then everyone's published ones."""
    from db import get_db   # imported here so the offline seed check never needs a database

    with get_db() as conn:
        public = _public_pool(conn)
        if org_id and not public_only:
            mine = _org_pool(conn, org_id, public.corpus)
            own_ids = frozenset(mine.by_id)
            # An org sees its own working copy, never the public twin of it.
            return [mine, public], (lambda e: e.public is False or e.id not in own_ids)
    return [public], (lambda e: e.public)


def invalidate() -> None:
    """Drop any in-memory index so the next call rebuilds it (called after writes)."""
    _LIVE.clear()


def _relations(subject_id: Optional[str], pools: list) -> dict:
    """{candidate id: "parent" | "child"} for the copies of the prompt being edited or viewed."""
    if not subject_id:
        return {}
    rel: dict = {}
    parent = None
    for pool in pools:
        e = pool.by_id.get(subject_id)
        if e and e.parent_id:
            parent = e.parent_id
            break
    if parent:
        rel[parent] = "parent"
    for pool in pools:
        for e in pool.entries:
            if e.parent_id == subject_id and e.id != subject_id:
                rel[e.id] = "child"
    return rel


def match_draft(draft: dict, org_id: Optional[str], exclude_id: Optional[str] = None, k: int = 5,
                mode: str = "live", public_only: bool = False) -> list[dict]:
    """Prompts that look like `draft`, best first, at most `k`.

    `mode`: "live" while the person types (cheap, never calls a model),
    "save" on Save: the same matching, then the optional AI second opinion
    (similarity_judge.review) on every "same" that isn't an exact copy and the
    candidates it was unsure about; any failure there gives exactly the "live"
    answer.
    `exclude_id`: the prompt being edited, never matched against itself; its
    original and its copies come back marked copy_of_yours.
    """
    draft = draft or {}
    canon = canonical_draft(draft)
    if canon.content_len < MIN_CONTENT_TOKENS:
        return []
    pools, allow = _view(org_id, public_only)
    exclude = frozenset([exclude_id]) if exclude_id else frozenset()
    relations = _relations(exclude_id, pools)
    review = None
    if mode == "save":
        from . import similarity_judge

        def review(pairs: list) -> None:
            similarity_judge.review(pairs, canon, draft, org_id, relations)
    return rank(canon, pools, max(1, int(k)), org_id if not public_only else None, allow, exclude,
                relations, review)


def similar_to_prompt(prompt_id: str, org_id: Optional[str], k: int = 6,
                      public_only: bool = False) -> list[dict]:
    """The "Similar prompts" row for a saved prompt the viewer can already see."""
    if not prompt_id:
        return []
    pools, allow = _view(org_id, public_only or not org_id)
    subject = None
    for pool in pools:
        e = pool.by_id.get(prompt_id)
        if e is not None and allow(e):
            subject = e
            break
    if subject is None:
        return []
    viewer = org_id if org_id and not public_only else None
    k = max(1, int(k))
    relations = _relations(prompt_id, pools)
    out = rank(subject.canon, pools, k, viewer, allow, frozenset([prompt_id]), relations)
    if len(out) < k and subject.canon.content_len >= MIN_CONTENT_TOKENS:
        out += _neighbours(subject, pools, allow, k - len(out), viewer, relations,
                           frozenset([prompt_id, *(m["id"] for m in out)]))
    return out


# The Similar row is for browsing, not for "is this a duplicate?": when the
# matcher finds fewer than k related prompts, the row is topped up with the
# nearest prompts by wording, same category first. These never reach
# match_draft (the adding-a-prompt check) and are always "related".
NEIGHBOUR_SAME_CATEGORY = 0.10
NEIGHBOUR_ANY_CATEGORY = 0.20


def _neighbours(subject: "Entry", pools: list, allow, n: int, viewer: Optional[str], relations: dict,
                exclude: frozenset) -> list:
    corpus = pools[0].corpus
    q = make_query(subject.canon, corpus)
    cat = subject.canon.use_case
    picks = []
    for e, _ in candidates(q, pools, allow, exclude):
        p = _prelim(q, e)
        same_cat = bool(cat) and e.canon.use_case == cat
        if p >= (NEIGHBOUR_SAME_CATEGORY if same_cat else NEIGHBOUR_ANY_CATEGORY):
            picks.append((p + (0.1 if same_cat else 0.0), e))
    picks.sort(key=lambda x: (-x[0], x[1].id))
    out = []
    for p, e in picks[:n]:
        pr = Pair(e, {}, None, score=0.0, verify=0.0, level="related")
        out.append(_match_dict(pr, subject.canon, corpus, viewer, relations.get(e.id)))
    return out


def _search_ranked(query: str, pools: list, allow) -> list:
    """Ids by relevance of title, description and text to a short search query."""
    corpus = pools[0].corpus
    canon = canonical(query, query, "", "")
    qterms = [t for t in _unigrams(canon.tokens)]
    if not qterms:
        return []
    qset = set(qterms)
    weights = {t: corpus.word(t) for t in qset}
    total = sum(weights.values()) or 1.0
    seen: dict = {}
    for pool in pools:
        idxs: set = set()
        for t in qset:
            idxs.update(pool.postings.get(t, ()))
        for i in idxs:
            e = pool.entries[i]
            if e.id in seen or not allow(e):
                continue
            meta = set(e.canon.meta_tokens)
            body_hit = sum(weights[t] for t in qset if t in e.terms)
            meta_hit = sum(weights[t] for t in qset if t in meta)
            s = (0.6 * meta_hit + 0.4 * body_hit) / total
            if s > 0:
                seen[e.id] = s
    return sorted(seen, key=lambda i: (-seen[i], i))


def search(query: str, org_id: Optional[str], scope: str = "all", limit: int = 20) -> list[str]:
    """Ranked prompt ids for a library search box / MCP search_prompts.

    `scope`: "all" (own org + public), "mine" (own org only) or "public". The
    query goes through the same canonicalization as prompts ("summarize email"
    finds "Client email to 3 bullets"); plain title/description/category text
    hits are merged in after the ranked ones.
    """
    from . import store

    query = (query or "").strip()
    if not query:
        return []
    limit = max(1, min(int(limit), 100))
    if not org_id:
        scope, org_id = "public", ""
    elif scope not in ("all", "mine", "public"):
        scope = "all"
    if scope == "public":
        pools, allow = _view(None, True)
    else:
        pools, allow = _view(org_id, False)
        if scope == "mine":
            base = allow
            allow = (lambda e: base(e) and e.public is False)
    ranked = _search_ranked(query, pools, allow)
    plain = [r["id"] for r in store.list_prompts(org_id, scope, query, None, limit=limit)]
    out = list(dict.fromkeys([*[i for i in plain if i in ranked[:limit]], *ranked, *plain]))
    return out[:limit]
