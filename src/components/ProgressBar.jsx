export default function ProgressBar({ progress, visible }) {
    if (!visible) return null;
    return (
        <div className="progress-container">
            <div
                className="progress-bar"
                style={{ width: `${progress}%` }}
            />
        </div>
    );
}
