// UI functionality for WebShare application
document.addEventListener("DOMContentLoaded", () => {
    // Show file name when selected
    const fileInput = document.getElementById("fileInput");
    const fileNameDisplay = document.getElementById("fileName");

    fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) {
            const file = fileInput.files[0];
            fileNameDisplay.textContent = `${file.name} (${formatFileSize(file.size)})`;
            fileNameDisplay.style.display = "block";
        } else {
            fileNameDisplay.style.display = "none";
        }
    });

    // Theme toggle
    const themeToggle = document.getElementById("themeToggle");
    const themeIcon = themeToggle.querySelector("i");

    themeToggle.addEventListener("click", () => {
        document.body.classList.toggle("light-theme");
        if (document.body.classList.contains("light-theme")) {
            themeIcon.className = "icon-sun";
        } else {
            themeIcon.className = "icon-moon";
        }
    });

    // Generate random room ID
    const generateRoomBtn = document.getElementById("generateRoomBtn");
    const roomInput = document.getElementById("roomInput");

    generateRoomBtn.addEventListener("click", () => {
        roomInput.value = Math.random().toString(36).substring(2, 10);
    });

    // About modal functionality
    const aboutLink = document.getElementById("aboutLink");
    aboutLink.addEventListener("click", (e) => {
        e.preventDefault();
        alert("WebShare is a secure peer-to-peer file sharing application that uses WebRTC technology to transfer files directly between browsers without storing them on a server. All connections are encrypted end-to-end.");
    });

    // Setup drag and drop for files
    const dropZone = document.querySelector(".file-input-label");

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, highlight, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, unhighlight, false);
    });

    function highlight() {
        dropZone.style.borderColor = "#6cb2eb";
        dropZone.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
    }

    function unhighlight() {
        dropZone.style.borderColor = 'rgba(255, 255, 255, 0.2)';
        dropZone.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
    }

    dropZone.addEventListener('drop', handleDrop, false);

    function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;

        if (files.length > 0) {
            fileInput.files = files;
            const file = files[0];
            fileNameDisplay.textContent = `${file.name} (${formatFileSize(file.size)})`;
            fileNameDisplay.style.display = "block";
        }
    }
});

// Helper function to format file size
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + " bytes";
    else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    else if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
    else return (bytes / 1073741824).toFixed(1) + " GB";
}