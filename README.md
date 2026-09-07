# 14-High! Card Game Scoring App

A Progressive Web App (PWA) for keeping score in the 14-High card game.

## Features

- Track scores for the 14-High card game
- Works offline after initial load
- Installable on mobile and desktop devices
- Automatic game state saving
- Dark/light mode
- Full round history with bids, hands won, round points, and running scores
- Google Analytics usage and privacy-safe gameplay milestone tracking
- Mobile-friendly design

## How to Use

1. **Adding Players**: Enter player names and click "Add" to add them to the game.
2. **Starting a Game**: Click "Start Game" to begin once you've added at least 2 players.
3. **Bidding Phase**: Enter each player's bid. The total bids cannot equal the current round number.
4. **Tricks Phase**: Enter how many hands each player won. The total must equal the current round number.
5. **Scoring**: Scores are calculated automatically after each round.
6. **Round History**: Review every finished round during a game, including each bid, hands won, points earned, and running score.
7. **Game History**: Open a completed game from the menu to review final standings and its full round-by-round history.
8. **Dark/Light Mode**: Toggle in the menu.
9. **Transfer a Game**: On the scoring device, tap **Hand-off via QR**. On the receiving device, open the installed 14-High app and tap **Import from QR**, then allow camera access. Point it at the displayed code until the game opens automatically in the same app. Larger games cycle through several codes; keep scanning until all parts are collected. Players, dealer, bids, hands won, scores, eliminations, and round history transfer together. The imported game replaces the receiving device's current game.

Use **Import from QR inside 14-High** for transfers into the installed PWA. The QR contains game data, not a browser link. Copy Import Data and paste inside the app if camera access is unavailable. Older import links and QR codes are still accepted. Copy Link/Share remain available as browser-link fallbacks. Camera scanning requires HTTPS (or localhost during development); after the app has cached, transfers also work offline.

## Installation on Mobile Devices

### iOS
1. Open Safari and navigate to the app URL
2. Tap the Share button (rectangle with arrow)
3. Scroll down and tap "Add to Home Screen"
4. Choose a name and tap "Add"

### Android
1. Open Chrome and navigate to the app URL
2. Tap the menu (three dots)
3. Tap "Add to Home Screen"
4. Follow the prompts to install

## Development Setup

### Prerequisites
- A web server to host the static files
- Basic knowledge of HTML, CSS, and JavaScript

### Development Environment
1. Clone the repository
2. Open files in your preferred code editor
3. Serve the files using a local web server

```sh
# Example using Python's built-in server
python -m http.server 8000
```

4. Visit http://localhost:8000 in your browser

### Icon Generation
The app icon source is `/icons/icon-source.svg`. Export it to the PNG sizes listed in `manifest.json` and place the generated files in `/icons`.

## Deploying

Being a purely static web app, 14-High! can be deployed to any web hosting service:

1. **GitHub Pages**: Push to a GitHub repository and enable GitHub Pages
2. **Netlify/Vercel**: Connect your repository for automatic deployments
3. **Traditional Hosting**: Upload files to your web server via FTP/SFTP

## Testing the PWA

1. Deploy to a hosting service with HTTPS (required for service workers)
2. Visit the site in a modern browser
3. Try refreshing with the network disconnected to test offline mode
4. Install to your home screen to test the full PWA experience

### Regression Tests

Run all regression checks with:

```sh
node --test tests/*.mjs
```

### Browser QR Regression Test

With a local server running on port 8014 and Playwright/Chromium available, run:

```sh
node tests/browser/handoff.mjs
```

Set `TEST_BASE_URL` for another server, `PLAYWRIGHT_MODULE` for an existing Playwright module path, or `TEST_ARTIFACTS` for screenshot output. This test sends real generated QR images through a simulated camera video feed into the bundled decoder, checks exact game/history preservation and same-window import, then verifies camera cleanup and an offline re-import. It does not substitute a fake decoder. A physical phone camera check is still useful for focus and permission behavior on iOS/Android.

## Analytics

The production site uses Google Analytics 4 measurement ID `G-553V1C3J93`. It records page activity and privacy-limited gameplay milestones such as game starts, completed rounds, completed games, and QR hand-offs.

Analytics event parameters are explicitly allowlisted. Player names, bids, hands won, scores, and saved game state are never sent. Google Signals and ad-personalization signals are disabled.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
