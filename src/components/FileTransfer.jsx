import React from "react";

export default function FileTransfer({
                                         connected,
                                         fileName,
                                         setFileName,
                                         selectFile,
                                         sendFile,
                                         sending
                                     }) {
    const [isDragging, setIsDragging] = React.useState(false);
    const fileInputRef = React.useRef(null);

    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        const droppedFile = e.dataTransfer.files[0] || null;
        if (droppedFile) {
            setFileName(droppedFile.name);
            selectFile(droppedFile);
            fileInputRef.current.files = e.dataTransfer.files;
        }
    };

    const handleDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
    };

    const handleDragLeave = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
    };

    const handleFileChange = (e) => {
        const file = e.target.files[0] || null;
        setFileName(file ? file.name : '');
        selectFile(file);
    };

    return (
        <>
            <div
                className={`file-input-container border-2 border-dashed rounded-lg p-4 transition-all ${
                    isDragging ? 'border-blue-400 bg-blue-400/10' : 'border-gray-500'
                }`}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
            >
                <label className="file-input-label flex flex-col items-center gap-2 cursor-pointer" htmlFor="fileInput">
                    <span className="text-blue-400">📄</span>
                    <span className="text-sm">
                        {isDragging ? 'Drop file here' : 'Choose file or drag & drop'}
                    </span>
                    <input
                        id="fileInput"
                        type="file"
                        className="file-input hidden"
                        disabled={!connected || sending}
                        onChange={handleFileChange}
                        ref={fileInputRef}
                    />
                </label>
                {fileName && (
                    <div className="file-name text-sm text-gray-400 mt-2">{fileName}</div>
                )}
            </div>
            <button
                id="sendBtn"
                disabled={!connected || !fileName || sending}
                onClick={sendFile}
                className="w-full py-2 mt-4 bg-blue-600 hover:bg-blue-400 rounded-lg disabled:bg-gray-600 transition-all"
            >
                Send
            </button>
        </>
    );
}