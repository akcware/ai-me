import WAWebJS, { Client, LocalAuth, MessageMedia } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import OpenAI from "openai";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fs from "fs";
import path from "path";
import { ElevenLabsClient } from "elevenlabs"; // Added ElevenLabsClient import
import { startLogServer } from './logServer'; // Added import for log server

const ADMIN_NUMBER = "491627609755@c.us";
const SYSTEM_PROMPT_PATH = path.join(__dirname, "system-prompt.txt");

// Add bot availability control
let isBotEnabled = true;

// Add logging utility function at the top
function logToFile(message: string, type: 'info' | 'error' = 'info') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${type.toUpperCase()}] ${message}\n`;
  fs.appendFileSync(path.join(__dirname, 'logs.txt'), logMessage);
}

// Add process handlers for unexpected shutdowns
process.on('uncaughtException', (error) => {
  logToFile(`Uncaught Exception: ${error.message}`, 'error');
  logToFile(`Stack: ${error.stack}`, 'error');
  logToFile('Application terminated with error', 'error');
  process.exit(1);
});

process.on('SIGINT', () => {
  logToFile('Application terminated by user');
  process.exit(0);
});

// Helper function to check if sender is admin
function isAdmin(sender: string): boolean {
  return sender === ADMIN_NUMBER;
}

// Function to handle bot availability commands
async function handleAvailabilityCommand(message: WAWebJS.Message) {
  const statusMessage = `Bot status: ${isBotEnabled ? 'enabled' : 'disabled'}`;
  
  if (message.body === '@status') {
    if (message.fromMe) message.reply(statusMessage);
    else client.sendMessage(message.from, statusMessage);
    return true;
  }
  
  if (!isAdmin(message.from)) return;

  if (message.body === '@disable') {
    isBotEnabled = false;
    if (message.fromMe) message.reply('Bot is now disabled');
    else client.sendMessage(message.from, 'Bot is now disabled');
    return true;
  } else if (message.body === '@enable') {
    isBotEnabled = true;
    if (message.fromMe) message.reply('Bot is now enabled');
    else client.sendMessage(message.from, 'Bot is now enabled');
    return true;
  }
  return false;
}

// Replace currentSystemPrompt variable with these functions
async function loadSystemPrompt(): Promise<string> {
  try {
    const content = await fs.promises.readFile(SYSTEM_PROMPT_PATH, "utf8");
    // Get the last prompt by splitting on separator and taking the last non-empty section
    const sections = content.split("=== System Prompt");
    const lastSection = sections[sections.length - 1];
    if (!lastSection) return content; // Return all content if no sections found

    // Extract prompt content between the timestamp line and end marker
    const promptContent = lastSection
      .split("\n")
      .slice(2) // Skip timestamp line and empty line
      .join("\n")
      .split("=== End of Prompt ===")[0]
      .trim();

    return promptContent || content; // Return full content if parsing fails
  } catch (error) {
    console.error("Error loading system prompt:", error);
    return ""; // Return empty string or a default prompt
  }
}

async function saveSystemPrompt(prompt: string): Promise<void> {
  try {
    // Add timestamp and separator
    const timestamp = new Date().toISOString();
    const promptWithMetadata = `\n\n=== System Prompt (${timestamp}) ===\n${prompt}\n=== End of Prompt ===\n`;

    // Append to file instead of overwriting
    await fs.promises.appendFile(
      SYSTEM_PROMPT_PATH,
      promptWithMetadata,
      "utf8"
    );
  } catch (error) {
    console.error("Error saving system prompt:", error);
  }
}

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: "auth",
  }),
  puppeteer: {
    args: ['--no-sandbox'],
  },
});

const openai = new OpenAI();
const elevenlabs = new ElevenLabsClient();

let db: any;
async function initDB() {
  try {
    logToFile('Initializing database...');
    db = await open({
      filename: "conversation.db",
      driver: sqlite3.Database,
    });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS conversation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT,
        role TEXT,
        content TEXT
      )
    `);
    logToFile('Database initialized successfully');
    
    // Start the log server
    startLogServer();
    
  } catch (error) {
    logToFile(`Database initialization failed: ${error.message}`, 'error');
    throw error;
  }
}

async function sendToGPT(message: string, from: string, userName: string) {
  logToFile(`Sending message to GPT - User: ${userName}, Content: ${message}`);
  const storedMessages = await db.all(
    "SELECT role, content FROM conversation WHERE user = ? ORDER BY id",
    [from]
  );
  
  // Parse stored messages properly
  const parsedMessages = storedMessages.map(msg => ({
    role: msg.role,
    content: msg.role === 'assistant' ? msg.content : JSON.parse(msg.content)[0].text
  }));

  parsedMessages.push({
    role: "user",
    content: `${userName}: ${message}`
  });

  // Initialize messages with or without system prompt based on @pro flag
  const isPro = message.includes("@pro");
  const model = isPro ? "o1-preview" : "gpt-4o-mini";
  
  let messages;
  if (isPro) {
    messages = [...parsedMessages];
  } else {
    const systemPrompt = {
      role: "system",
      content: await loadSystemPrompt(),
    };
    messages = [systemPrompt, ...parsedMessages];
  }

  try {
    const completion = await openai.chat.completions.create({
      model: model,
      messages: messages,
    });
    logToFile(`Received GPT response for ${userName}`);
    const responseContent = completion.choices[0].message.content;
    
    // Store messages in a consistent format
    await db.run(
      "INSERT INTO conversation(user, role, content) VALUES(?, ?, ?)",
      [from, "user", JSON.stringify([{ type: "text", text: message }])]
    );
    await db.run(
      "INSERT INTO conversation(user, role, content) VALUES(?, ?, ?)",
      [from, "assistant", responseContent]
    );
    return responseContent;
  } catch (error) {
    logToFile(`Error communicating with GPT: ${error.message}`, 'error');
    throw error;
  }
}

async function handleAudioMessage(message: WAWebJS.Message, userName: string) {
  try {
    logToFile(`Processing audio message from ${userName}`);
    console.log("[Audio] Starting to process audio message...");
    const media = await message.downloadMedia();
    if (!media || !media.data) {
      console.log("[Audio] Failed to download media or media data is empty");
      return;
    }
    console.log("[Audio] Media downloaded successfully:", {
      mimetype: media.mimetype,
      dataLength: media.data.length,
    });

    // Save base64 audio to temp file
    const tempDir = path.join(__dirname, "temp");
    console.log("[Audio] Using temp directory:", tempDir);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
      console.log("[Audio] Created temp directory");
    }
    const audioPath = path.join(tempDir, `audio_${Date.now()}.ogg`);
    fs.writeFileSync(audioPath, Buffer.from(media.data, "base64"));
    console.log("[Audio] Saved audio file to:", audioPath);

    // Transcribe audio
    console.log("[Audio] Starting transcription...");
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
    });
    console.log("[Audio] Transcription result:", transcription.text);

    // Process with GPT
    console.log("[Audio] Sending transcription to GPT...");
    const gptResponse = await sendToGPT(
      transcription.text,
      message.from,
      userName
    );
    console.log("[Audio] GPT response received:", gptResponse);

    // Replace OpenAI TTS with ElevenLabs
    console.log("[Audio] Starting ElevenLabs audio generation...");
    console.log("[Audio] Generating audio for text:", gptResponse);

    const audio = await elevenlabs.generate({
      voice: "sSi6CCzNGi3HIOpuj4Eo",
      text: gptResponse,
      model_id: "eleven_multilingual_v2",
    });
    console.log(
      "[Audio] ElevenLabs generation successful, starting buffer creation"
    );

    // New buffer handling code
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    try {
      for await (const chunk of audio) {
        chunks.push(chunk);
        totalLength += chunk.length;
        console.log("[Audio] Received chunk of size:", chunk.length);
      }
    } catch (streamError) {
      console.error("[Audio] Stream error:", streamError);
      throw new Error("Failed to read audio stream");
    }

    if (chunks.length === 0) {
      throw new Error("No audio data received from ElevenLabs");
    }

    const audioBuffer = Buffer.concat(chunks, totalLength);
    console.log(
      "[Audio] Buffer created successfully, size:",
      audioBuffer.length
    );

    if (audioBuffer.length === 0) {
      throw new Error("Audio buffer is empty");
    }

    const base64Audio = audioBuffer.toString("base64");
    console.log(
      "[Audio] Converted audio to base64, length:",
      base64Audio.length
    );

    // Create WhatsApp audio message
    const audioMessage = new MessageMedia(
      "audio/ogg",
      base64Audio,
      `audio_${Date.now()}.ogg`
    );
    console.log("[Audio] Created WhatsApp audio message");

    // Send audio response
    await client.sendMessage(message.from, audioMessage, {
      sendAudioAsVoice: true,
    });
    console.log("[Audio] Sent audio response successfully");

    // Cleanup temp file
    fs.unlinkSync(audioPath);
    console.log("[Audio] Cleaned up temporary file");
  } catch (error) {
    const errorMessage = `Error processing audio: ${error.message}`;
    console.error("[Audio] Error processing audio:", error);
    logToFile(errorMessage, 'error');
    console.error("[Audio] Error details:", {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    client.sendMessage(
      message.from,
      "Sorry, there was an error processing your audio message."
    );
  }
}

async function handleImageMessage(message: WAWebJS.Message, userName: string) {
  try {
    logToFile(`Processing image message from ${userName}`);
    console.log("[Vision] Starting to process image message...");
    const media = await message.downloadMedia();
    if (!media || !media.data) {
      console.log("[Vision] Failed to download media or media data is empty");
      return;
    }

    console.log("[Vision] Image downloaded successfully");

    // Get user's question from message body, remove @gpt and @pro tags
    const userQuestion =
      message.body.replace("@gpt", "").replace("@pro", "").trim() ||
      "What's in this image? Please describe it concisely.";

    // Initialize messages with system prompt and user name
    const systemPrompt = {
      role: "system",
      content: await loadSystemPrompt(),
    };
    const userNameMessage = {
      role: "user",
      content: `My name is ${userName}.`,
    };
    const userMessage = {
      role: "user",
      content: [
        { type: "text", text: userQuestion },
        {
          type: "image_url",
          image_url: {
            url: `data:${media.mimetype};base64,${media.data}`,
          },
        },
      ],
    };
    const messages = [systemPrompt, userNameMessage, userMessage];

    // Choose model based on message content
    const model = message.body.includes("@pro") ? "o1" : "gpt-4o";

    // Call Vision API
    const response = await openai.chat.completions.create({
      model: model,
      messages: messages,
      max_tokens: 500,
    });

    console.log("[Vision] Got response from Vision API");
    const description = response.choices[0].message.content;

    if (message.fromMe) message.reply(description);
    else await client.sendMessage(message.from, description);
    console.log("[Vision] Sent description to user");
  } catch (error) {
    const errorMessage = `Error processing image: ${error.message}`;
    console.error("[Vision] Error processing image:", error);
    logToFile(errorMessage, 'error');
    console.error("[Vision] Error details:", {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    if (message.fromMe)
      message.reply("Sorry, there was an error processing your image.");
    else
      client.sendMessage(
        message.from,
        "Sorry, there was an error processing your image."
      );
  }
}

// Add greeting handler function
// Add this helper function before the client.on("message_create") handler
function containsGreeting(message: string): boolean {
  // Normalize and convert to lowercase for better matching
  const normalizedMsg = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  // Array of possible greetings with variations
  const greetings = [
    'gunayd',    // Covers: gunaydin, gunaydın
    'günayd',    // Covers: günaydın
    'iyi gece',  // Covers: iyi geceler
    'ıyi gece',  // Covers: ıyi geceler
    'iyi gündüz',
    'iyi günler',
    'ıyi günler'
  ];

  return greetings.some(greeting => normalizedMsg.includes(greeting));
}

async function handleImageGeneration(message: WAWebJS.Message, prompt: string) {
  try {
    logToFile(`Generating image for prompt: ${prompt}`);
    
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: prompt,
      n: 1,
      size: "1024x1024",
    });

    if (response.data[0].url) {
      const imageUrl = response.data[0].url;
      const imageResponse = await fetch(imageUrl);
      const buffer = await imageResponse.arrayBuffer();
      const base64Data = Buffer.from(buffer).toString('base64');
      
      const media = new MessageMedia(
        'image/jpeg',
        base64Data,
        'generated-image.jpg'
      );
      
      if (message.fromMe) {
        await message.reply(media);
      } else {
        await client.sendMessage(message.from, media);
      }
      
      logToFile('Image generated and sent successfully');
    }
  } catch (error) {
    logToFile(`Error generating image: ${error.message}`, 'error');
    const errorMessage = "Sorry, there was an error generating the image.";
    if (message.fromMe) message.reply(errorMessage);
    else client.sendMessage(message.from, errorMessage);
  }
}

client.on("ready", () => {
  console.log("Client is ready!");
  logToFile("WhatsApp client is ready and connected");
});

client.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
});

// Add new connection status handlers
client.on("disconnected", (reason) => {
  logToFile(`Client was disconnected. Reason: ${reason}`, 'error');
});

client.on("authenticated", () => {
  logToFile("Client has been authenticated successfully");
});

initDB().then(() => {
  logToFile('Application starting...');
  client.initialize().catch(error => {
    logToFile(`Failed to initialize client: ${error.message}`, 'error');
  });
});

let messageQueue: WAWebJS.Message[] = [];
let debounceTimer: NodeJS.Timeout | null = null;

client.on("message_create", async (message) => {
  logToFile(`New message received from ${message.from}`);
  
  // Check availability command first
  if (await handleAvailabilityCommand(message)) {
    logToFile(`Handled availability command from ${message.from}`);
    return;
  }

  // Check if bot is disabled and message is not from admin
  if (!isBotEnabled && !isAdmin(message.from)) {
    if (message.body.includes('@gpt')) {
      logToFile(`Rejected message from ${message.from} - bot is disabled`);
      client.sendMessage(message.from, "Sorry, the bot is currently disabled.");
    }
    return;
  }

  // Retrieve user's name, handle undefined
  const contact = await message.getContact();
  const userName = contact.name || "there";
  logToFile(`Processing message from ${userName} (${message.from})`);

  if (message.hasMedia) {
    if (message.type === "ptt") {
      if (message.fromMe) return;
      logToFile(`Processing voice message from ${userName}`);
      await handleAudioMessage(message, userName);
      return;
    } else if (message.type === "image" && message.body.includes("@gpt")) {
      logToFile(`Processing image message from ${userName}`);
      await handleImageMessage(message, userName);
      return;
    }
  }

  if (message.body.startsWith("@draw")) {
    logToFile(`Processing draw request from ${userName}`);
    const prompt = message.body.substring(5).trim();
    await handleImageGeneration(message, prompt);
    return;
  }

  if (message.body.includes("@gpt") || (containsGreeting(message.body) && message.from == "905339388217@c.us")) {
    logToFile(`Processing GPT request from ${userName}: ${message.body}`);
    const gptResponse = await sendToGPT(message.body, message.from, userName);
    logToFile(`Sending GPT response to ${userName}`);

    try {
      if (message.hasQuotedMsg) {
        const quotedMsg = await message.getQuotedMessage();
        await client.sendMessage(message.from, gptResponse, { quotedMessageId: quotedMsg.id._serialized });
      } else {
        await client.sendMessage(message.from, gptResponse);
      }
    } catch (error) {
      console.error('Error sending reply:', error);
      // Fallback to sending message without quote
      await client.sendMessage(message.from, gptResponse);
    }
    return;
  }

  /*
  messageQueue.push(message);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const messagesBySender = new Map<string, string[]>();

    messageQueue.forEach((queuedMsg) => {
      const from = queuedMsg.from;
      if (!messagesBySender.has(from)) {
        messagesBySender.set(from, []);
      }
      messagesBySender.get(from)?.push(queuedMsg.body || "");
    });

    messagesBySender.forEach((msgs, from) => {
      const combined = msgs.join("\n");
      client.sendMessage(from, combined);    });

    messageQueue = [];
  }, 4000);*/
});
