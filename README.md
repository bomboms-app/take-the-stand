# Take the Stand

**Your own journal takes the stand against your plans.** A private, on-device AI cross-examination built on the QVAC SDK. No cloud. No API key. No one reading over your shoulder.

| | |
|---|---|
| **Code** | https://github.com/bomboms-app/take-the-stand |
| **Runs at** | http://localhost:3000 (on your own computer, with `npm run web`) |
| **Powered by** | [QVAC SDK](https://github.com/tetherto) (`@qvac/sdk`), fully on-device |

## The idea

Most of us know our own patterns and ignore them anyway. Take the Stand makes you face them.

Tell it what you're about to do, for example "I'm going to quit and go freelance." It searches your journal for entries that contradict the plan or repeat an old pattern, lays them out as numbered exhibits on a timeline, and lets a local AI play the part of your past self. It questions you, cites the exhibits, closes with one hard question, and gives a verdict.

## How a session goes

1. You state your plan.
2. The app pulls the relevant exhibits from your notes.
3. Your past self cross-examines you.
4. You get one final question and a verdict.

Use it in the terminal or in the browser (violet courtroom page).

## Run it

```bash
git clone https://github.com/bomboms-app/take-the-stand.git
cd take-the-stand
npm install
```

Terminal:

```bash
npm start
```

Browser:

```bash
npm run web
```

Then open http://localhost:3000. Press `Ctrl+C` to stop. To change the port, set `PORT` (Windows: `set PORT=4000`).

The address is local only. The server listens on `127.0.0.1`, so the page opens only on the computer running it, and only while it runs.

## Use your own journal

Point the app at any folder of `.md` or `.txt` files. Name files by date (for example `2024-05-19.md`) to place them on the timeline.

Windows Command Prompt:

```
set PAST_YOU_NOTES=./notes-private
npm start
```

Entries you add in the browser are saved to `my-notes/` (change with `PAST_YOU_MY_NOTES`) and load in both the terminal and browser versions.

The `notes/` folder contains fictional sample entries so the demo works right away. `notes-private/` and `my-notes/` are git-ignored, so your real journal is never committed.

## Privacy

All AI runs locally through QVAC. Your journal never leaves your machine.

## What's inside

```
court.js            terminal app
server.js           web server
lib.js              shared logic
qvac.config.json    QVAC model settings
notes/              fictional sample journal
public/index.html   web interface
```

## Built for

The Tether QVAC SDK on-device AI app challenge.

## License

MIT, see [LICENSE](LICENSE).
Built for the Tether QVAC SDK app challenge.
