import PeerInfo from './PeerInfo'
import RoomForm from './RoomForm'

export default function RoomCard({ room, setRoom, connected, peers, joinRoom }) {
    return (
        <section className="card room-section">
            <RoomForm
                room={room}
                setRoom={setRoom}
                connected={connected}
                joinRoom={joinRoom}
            />
            <div className="room-status">
                <span id="roomDisplay">Room: {room || '—'}</span>
                <span className="status-indicator">
          <span className={`indicator-dot${connected ? " connected" : ""}`}></span>
                    {connected ? "Connected" : "Waiting"}
        </span>
            </div>
            <PeerInfo peers={peers} />
        </section>
    );
}
