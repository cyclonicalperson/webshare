# webshare
An browser-based P2P file sharing tool using WebRTC.<br>
The project is currently hosted on https://websharer.netlify.app/
<p align="center">
  <img src="https://github.com/user-attachments/assets/d2cbe9c3-4976-445d-b7f1-a4d78a11617a">
</p>

## Features

- **P2P File Sharing**: Direct file transfers between users without intermediary servers.
- **WebRTC Integration**: Leverages WebRTC for real-time, low-latency communication.
- **User-Friendly Interface**: Simple and intuitive design for easy file sharing.
- **Secure Transfers**: Data is transferred directly between peers, reducing exposure to external threats.

## Usage

1. **Open Webshare**: Navigate to https://websharer.netlify.app/ in your browser.<br><br>
2. **Connect to a Room**: Input an room number and connect to a room together with the second user.<br><br>
3. **Share Files**:
  - Click on the "Share File" button.<br>
  - Select the file you wish to share.<br>
  - Click on the "Send" button to send the file.<br>
4. **Receive Files**:
  - The file transfer initiates directly between the two browsers.<br>
  - The recipient recieves the file in their browser.<br>

## Prerequisites

- Node.js installed on your machine.
- A modern web browser (e.g., Chrome, Firefox, Edge) that supports WebRTC.

## Installation

1. Clone the repository

```bash
git clone https://github.com/cyclonicalperson/webshare.git
cd webshare
```

2. Install dependencies

```bash
npm install
```

3. Start the application

```bash
npm run dev
```

4. Access the application

  Open your web browser and navigate to http://localhost:5173.

## Project Structure

```
webshare/
├── src/                       ## Frontend React application
│   ├── assets
│   │   └── icon.png           # The website icon
│   ├── components
│   │   ├── FileCard.jsx
│   │   ├── FileTransfer.jsx
│   │   ├── Footer.jsx
│   │   ├── Header.jsx
│   │   ├── PeerInfo.jsx
│   │   ├── ProgressBar.jsx
│   │   ├── RoomCard.jsx
│   │   ├── RoomForm.jsx
│   │   └── StatusBar.jsx
│   ├── hooks
│   │   └── useWebRTC.js       # The WebRTC logic for connecting and file transfering
│   ├── App.css
│   ├── App.jsx
│   ├── index.css
│   └── main.jsx
├── server/                    ## Backend Express server
│   ├── server.js              # Server for signaling
│   ├── package.json           # Server dependencies
│   ├── Dockerfile             # Docker file for deployment
│   └── .dockerignore
├── LICENCE
└── README.md
```

## Technologies Used

- **Frontend**: React, WebRTC
- **Backend**: Node.js, Express (server hosting)
- **Real-time Communication**: WebRTC Data Channels, WebSockets

## Contributing

Feel free to open issues or submit pull requests for improvements or bug fixes.

## License

GPL-3.0 License. See [LICENSE](LICENSE) for details.
