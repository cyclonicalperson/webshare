export default function FileTransfer({
                                         connected,
                                         fileName,
                                         setFileName,
                                         selectFile,
                                         sendFile,
                                         sending
                                     }) {
    return (
        <>
            <div className="file-input-container">
                <label className="file-input-label" htmlFor="fileInput">
                    <span>📄 Choose file</span>
                    <input
                        id="fileInput"
                        type="file"
                        className="file-input"
                        disabled={!connected || sending}
                        onChange={e => {
                            const file = e.target.files[0];
                            setFileName(file ? file.name : '');
                            selectFile(file);
                        }}
                    />
                </label>
                {fileName && (
                    <div className="file-name">{fileName}</div>
                )}
            </div>
            <button
                id="sendBtn"
                disabled={!connected || !fileName || sending}
                onClick={sendFile}
            >
                Send
            </button>
        </>
    );
}
