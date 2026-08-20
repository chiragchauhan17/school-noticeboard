const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Create an 'uploads' directory to save staff images/videos
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Setup Multer (The engine that processes file uploads)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve all HTML files and uploads from a folder named 'public'
app.use(express.static('public')); 

// Temporary memory to store the active looping notices
let notices = [];

// API: The TV calls this to get the latest notices
app.get('/api/notices', (req, res) => {
    res.json(notices);
});

// API: The Admin Panel calls this to add a Text Notice
app.post('/api/notices/text', (req, res) => {
    const { content, duration } = req.body;
    notices.push({ type: 'html', content: content, duration: Number(duration) * 1000 });
    res.redirect('/admin.html');
});

// API: The Admin Panel calls this to upload an Image or Video
app.post('/api/notices/media', upload.single('mediaFile'), (req, res) => {
    const { duration } = req.body;
    const fileUrl = '/uploads/' + req.file.filename;
    const isVideo = req.file.mimetype.startsWith('video');
    
    notices.push({ 
        type: isVideo ? 'video' : 'image', 
        url: fileUrl, 
        duration: Number(duration) * 1000 
    });
    res.redirect('/admin.html');
});

// API: The Admin Panel calls this to delete all active notices
app.post('/api/notices/clear', (req, res) => {
    notices = [];
    res.redirect('/admin.html');
});

app.listen(PORT, () => console.log(`Noticeboard Server running on port ${PORT}`));
