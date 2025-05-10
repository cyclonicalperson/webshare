# webshare
An browser-based P2P file sharing tool using WebRTC<br>
The project is currently hosted on https://websharer.netlify.app/
<p align="center">
  <img src="https://github.com/user-attachments/assets/ad489639-e889-4343-b714-654ee81b3b9">
</p>

## Features

- **P2P File Sharing**: Direct file transfers between users without intermediary servers.
- **WebRTC Integration**: Leverages WebRTC for real-time, low-latency communication.
- **User-Friendly Interface**: Simple and intuitive design for easy file sharing.
- **Secure Transfers**: Data is transferred directly between peers, reducing exposure to external threats.

<br><br>

## Prerequisites for Development:
- Node.js installed on your machine.
- A modern web browser (e.g., Chrome, Firefox, Edge) that supports WebRTC.

## Installation

1. Clone the Repository:

```bash
git clone https://github.com/cyclonicalperson/webshare.git
cd webshare
```

2. Install Dependencies:

```bash
npm install
```

3. Start the Application:

```bash
npm start
```

4. Access the Application:

  Open your web browser and navigate to http://localhost:3000.

## Usage

1. **Open Webshare**: Navigate to http://localhost:3000 in your browser.<br><br>
2. **Share Files**:
  - Click on the "Share File" button.<br>
  - Select the file you wish to share. A unique link will be generated.<br>
  - Send the Link: Share the generated link with the recipient.<br>
3. **Receive Files**:
  - The recipient opens the link in their browser.<br>
  - The file transfer initiates directly between the two browsers.<br>

## Project Structure

```
webshare/
├── client/             ## Frontend React application
│   ├── index.html      # Website
│   ├── client.js       # Website backend communicating with the server
│   ├── _redirects
│   └── netlify.toml
├── server/             ## Backend Express server
│   ├── server.js       # Server for signaling
│   ├── package.json    # Server dependencies
│   ├── Dockerfile      # Docker file for deployment
│   └── .dockerignore
├── LICENCE
└── README.md
```

## Technologies Used

- **Frontend**: Angular, WebRTC
- **Backend**: Node.js, Express (server hosting)
- **Real-time Communication**: WebRTC Data Channels

## Contributing

Feel free to open issues or submit pull requests for improvements or bug fixes.

## License

GPL-3.0 License. See [LICENSE](LICENSE) for details.
