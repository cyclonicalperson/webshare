import './App.css'
import Header from './components/Header'
import RoomCard from './components/RoomCard'
import FileCard from './components/FileCard'
import Footer from './components/Footer'
import { useWebRTC } from './hooks/useWebRTC'

export default function App() {
    const webRTC = useWebRTC();

    return (
        <div className="container">
            <Header />
            <RoomCard
                room={webRTC.room}
                setRoom={webRTC.setRoom}
                connected={webRTC.connected}
                peers={webRTC.peers}
                joinRoom={webRTC.joinRoom}
            />
            <FileCard
                connected={webRTC.connected}
                fileName={webRTC.fileName}
                setFileName={webRTC.setFileName}
                selectFile={webRTC.selectFile}
                sendFile={webRTC.sendFile}
                progress={webRTC.progress}
                progressVisible={webRTC.progressVisible}
                status={webRTC.status}
                sending={webRTC.sending}
            />
            <Footer />
        </div>
    );
}
