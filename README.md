# Bluff Show

A bluffing trivia party game for 3 to 10 players, styled like a 70s TV quiz show.

## How it plays

1. A strange-but-true question appears with a blank: *"A group of crows is called a ____."*
2. Everyone secretly writes a **fake answer** that sounds real.
3. The fakes are shuffled in with the real answer.
4. Everyone picks the answer they think is **true**.
5. **+1000** for finding the truth, **+500** for every player your lie fooled.
   The last round is worth double. At the end: a podium, a Master Liar and a
   Truth Detective.

## Two ways to play

- **Play on this device:** pass one phone, tablet or laptop around. Works offline,
  needs nothing set up.
- **Host a room:** a TV or laptop shows the game, and everyone joins on their own
  phone by scanning the QR code or typing the 4-letter room code. Messages travel
  through Supabase Realtime, so this needs `config.js` filled in.

## Your own questions

In setup, **Write questions** lets you add facts about people in the room
(*"Hafiz's first job was ____."*). Whoever wrote one sits that round out, and
custom questions come up first. To add questions permanently, edit
`questions.js`: 151 questions in six categories, each with a source link.

## Files

| File | What it is |
|---|---|
| `index.html` | Every screen and the whole look |
| `app.js` | Moving between screens; host and phone behaviour |
| `engine.js` | The rules: lies, picks, scoring. No screen code |
| `room.js` | Room mode messenger (Supabase, or BroadcastChannel for tests) |
| `questions.js` | The question bank |
| `config.js` | Supabase address and publishable key for room mode |
| `fx.js` | The effects layer: confetti, stars, flashes and real sound, drawn by Phaser over the page |
| `sounds.js` | The sound bank, from Kenney's free CC0 packs, rebuilt by `tools/build_sounds.py` |
| `vendor/phaser.min.js` | Phaser 4, kept here so nothing is fetched from the internet |

## Effects

The show itself is plain HTML, because it is mostly typing and picking from
lists, which web pages do well and Phaser does not. On top of it,
[Phaser](https://phaser.io) 4 draws on a see-through canvas over the page: a
gold flash and a shower of stars when the TRUTH is stamped, a shake and a red
spray for a LIE, a ring round every score that goes up, and confetti and a
fanfare for the winner, with a real drum roll and saxophone stings in place of
the old beeps. It never takes a tap, it is asleep and hidden while anyone
types, and if Phaser fails to load the show runs on with its original tones.

## Tests

```bash
./test/run.sh
```

Runs the rules tests, then plays full games in headless Chrome: a pass-the-device
game at phone, phone-landscape, tablet and desktop sizes, and a room game with a TV
tab and three phone tabs talking over `?transport=local`. Then it checks the effects
layer twice, with Phaser's Canvas renderer and with WebGL: that it never blocks a tap,
stays asleep while someone types, fires each reveal's effect only while that answer
is on screen, never sprays over the points, honours reduce-motion, and that the show
still runs with Phaser missing. Needs Node and Google Chrome.
