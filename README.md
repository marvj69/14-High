# 14-High! Card Game Scoring App

A Progressive Web App (PWA) for keeping score in the 14-High card game.

## Features

- Track scores for the 14-High card game
- Works offline after initial load
- Installable on mobile and desktop devices
- Automatic game state saving
- Dark/light mode
- Game history tracking
- Mobile-friendly design

## How to Use

1. **Adding Players**: Enter player names and click "Add" to add them to the game.
2. **Starting a Game**: Click "Start Game" to begin once you've added at least 2 players.
3. **Bidding Phase**: Enter each player's bid. The total bids cannot equal the current round number.
4. **Tricks Phase**: Enter how many hands each player won. The total must equal the current round number.
5. **Scoring**: Scores are calculated automatically after each round.
6. **Game History**: Access previous game results from the menu.
7. **Dark/Light Mode**: Toggle in the menu.

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
The repository includes an icon generator:
1. Open `/generate-icons.html` in a web browser
2. Click "Download All Icons" to get all required icon sizes
3. Place the downloaded icons in the `/icons` directory

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

## License

This project is licensed under the MIT License - see the LICENSE file for details. 