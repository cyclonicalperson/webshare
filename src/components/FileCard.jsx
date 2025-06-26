import FileTransfer from './FileTransfer'
import ProgressBar from './ProgressBar'
import StatusBar from './StatusBar'

export default function FileCard({
                                     connected,
                                     fileName,
                                     setFileName,
                                     selectFile,
                                     sendFile,
                                     progress,
                                     progressVisible,
                                     status,
                                     sending
                                 }) {
    return (
        <section className="card file-section">
            <FileTransfer
                connected={connected}
                fileName={fileName}
                setFileName={setFileName}
                selectFile={selectFile}
                sendFile={sendFile}
                sending={sending}
            />
            <ProgressBar progress={progress} visible={progressVisible} />
            <StatusBar status={status} />
        </section>
    );
}
