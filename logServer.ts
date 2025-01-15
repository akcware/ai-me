import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.LOG_SERVER_PORT || 3000;
const logPath = path.join(__dirname, 'logs.txt');

// Store connected clients
let clients: express.Response[] = [];

// Read last N lines from file
function getLastLines(filePath: string, lineCount: number): string {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        return lines.slice(-lineCount).join('\n');
    } catch (error) {
        return '';
    }
}

// Watch for file changes
fs.watch(logPath, (eventType) => {
    if (eventType === 'change') {
        // Read only the last line
        const lastLine = getLastLines(logPath, 1);
        // Notify all connected clients
        clients.forEach(client => {
            client.write(`data: ${JSON.stringify({ log: lastLine })}\n\n`);
        });
    }
});

// SSE endpoint for live updates
app.get('/logs/live', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial logs (last 100 lines)
    const initialLogs = getLastLines(logPath, 100);
    res.write(`data: ${JSON.stringify({ log: initialLogs })}\n\n`);

    // Add client to list
    clients.push(res);

    // Remove client on connection close
    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
});

// Static logs endpoint
app.get('/logs', (req, res) => {
    if (!fs.existsSync(logPath)) {
        return res.status(404).send('Log file not found');
    }
    const stream = fs.createReadStream(logPath);
    res.setHeader('Content-Type', 'text/plain');
    stream.pipe(res);
});

// Serve a simple HTML page for viewing logs
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Live Logs</title>
            <style>
                body { background: #1e1e1e; color: #ddd; font-family: monospace; padding: 20px; }
                #logs { white-space: pre-wrap; }
                .timestamp { color: #569cd6; }
                .level { color: #4ec9b0; }
                .message { color: #ce9178; }
            </style>
        </head>
        <body>
            <div id="logs"></div>
            <script>
                const logsDiv = document.getElementById('logs');
                const eventSource = new EventSource('/logs/live');
                
                eventSource.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    const formattedLog = data.log
                        .replace(/\\[(.*?)\\]/g, (match) => {
                            if (match.includes('INFO') || match.includes('ERROR')) {
                                return '<span class="level">' + match + '</span>';
                            }
                            return '<span class="timestamp">' + match + '</span>';
                        })
                        .replace(/(?<=\\]\\s\\[.*?\\]\\s)(.*)/g, '<span class="message">$1</span>');
                    
                    logsDiv.innerHTML += formattedLog + '\\n';
                    window.scrollTo(0, document.body.scrollHeight);
                };

                eventSource.onerror = () => {
                    console.error('SSE error, reconnecting...');
                };
            </script>
        </body>
        </html>
    `);
});

export function startLogServer() {
    app.listen(PORT, () => {
        console.log(`Log server running at http://localhost:${PORT}`);
    });
}
