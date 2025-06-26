export default function RoomForm({ room, setRoom, connected, joinRoom }) {
    return (
        <form
            className="room-input-group"
            onSubmit={e => {
                e.preventDefault();
                if (room) joinRoom(room);
            }}
        >
            <input
                id="roomInput"
                type="text"
                placeholder="Enter room"
                value={room}
                onChange={e => setRoom(e.target.value)}
                disabled={connected}
            />
            <button
                id="joinRoomBtn"
                type="submit"
                disabled={connected || !room}
            >
                Join Room
            </button>
        </form>
    );
}
