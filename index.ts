import WAWebJS, { Client, LocalAuth, MessageMedia } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import OpenAI from "openai";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fs from "fs";
import path from "path";
import { ElevenLabsClient } from "elevenlabs";
import Wlog, { LogFormat } from "@akcware/wlog";
import cron from "node-cron";

// Initialize logger
const logger = new Wlog({
  logToConsole: true,
  logToFile: true,
  filePath: path.join(__dirname, "logs/app-logs"),
  fileFormat: LogFormat.TEXT,
  serverOptions: {
    enable: true,
    port: 3000,
    path: '/logs',
    livePath: '/live'
  }
});

const ADMIN_NUMBER = "491627609755@c.us";
const SYSTEM_PROMPT_PATH = path.join(__dirname, "system-prompt.txt");

// Add bot availability control
let isBotEnabled = true;
let isVoiceEnabled = true;

// Add process handlers for unexpected shutdowns
process.on("uncaughtException", (error) => {
  logger.error(`Uncaught Exception: ${error.message}`);
  logger.error(`Stack: ${error.stack}`);
  logger.error("Application terminated with error");
  process.exit(1);
});

process.on("SIGINT", () => {
  logger.info("Application terminated by user");
  process.exit(0);
});

// Helper function to check if sender is admin
function isAdmin(sender: string): boolean {
  return sender === ADMIN_NUMBER;
}

// Function to handle bot availability commands
async function handleAvailabilityCommand(message: WAWebJS.Message) {
  const statusMessage = `Bot status: ${isBotEnabled ? "enabled" : "disabled"}`;

  if (message.body === "@status") {
    if (message.fromMe) message.reply(statusMessage);
    else client.sendMessage(message.from, statusMessage);
    return true;
  }

  if (!isAdmin(message.from)) return;

  if (message.body === "@disable") {
    isBotEnabled = false;
    if (message.fromMe) message.reply("Bot is now disabled");
    else client.sendMessage(message.from, "Bot is now disabled");
    return true;
  } else if (message.body === "@enable") {
    isBotEnabled = true;
    if (message.fromMe) message.reply("Bot is now enabled");
    else client.sendMessage(message.from, "Bot is now enabled");
    return true;
  }
  return false;
}


// Add after handleAvailabilityCommand function
async function handleVoiceCommand(message: WAWebJS.Message): Promise<boolean> {
  if (!isAdmin(message.from)) return false;

  const statusMessage = `Voice processing is ${isVoiceEnabled ? "enabled" : "disabled"}`;

  if (message.body === "@voicestatus") {
    if (message.fromMe) message.reply(statusMessage);
    else client.sendMessage(message.from, statusMessage);
    return true;
  }

  if (message.body === "@disablevoice") {
    isVoiceEnabled = false;
    if (message.fromMe) message.reply("Voice processing is now disabled");
    else client.sendMessage(message.from, "Voice processing is now disabled");
    return true;
  } else if (message.body === "@enablevoice") {
    isVoiceEnabled = true;
    if (message.fromMe) message.reply("Voice processing is now enabled");
    else client.sendMessage(message.from, "Voice processing is now enabled");
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
    args: ["--no-sandbox"],
  },
});

const openai = new OpenAI();
const elevenlabs = new ElevenLabsClient();

let db: any;
async function initDB() {
  try {
    logger.info("Initializing database...");
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
    logger.info("Database initialized successfully");

    // Start the log server
  } catch (error) {
    logger.error(`Database initialization failed: ${error.message}`);
    throw error;
  }
}

async function sendToGPT(message: string, from: string, userName: string) {
  logger.info(`Sending message to GPT - User: ${userName}, Content: ${message}`);
  const storedMessages = await db.all(
    "SELECT role, content FROM conversation WHERE user = ? ORDER BY id",
    [from]
  );

  // Parse stored messages properly
  const parsedMessages = storedMessages.map((msg) => ({
    role: msg.role,
    content:
      msg.role === "assistant" ? msg.content : JSON.parse(msg.content)[0].text,
  }));

  parsedMessages.push({
    role: "user",
    content: `${userName}: ${message}`,
  });

  // Initialize messages with or without system prompt based on @pro flag
  const isPro = message.includes("@pro");
  const model = isPro ? "o4-mini" : "gpt-4.1";

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
    logger.info(`Received GPT response for ${userName}`);
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
    logger.error(`Error communicating with GPT: ${error.message}`);
    throw error;
  }
}

async function handleAudioMessage(message: WAWebJS.Message, userName: string) {
  try {
    logger.info(`Processing audio message from ${userName}`);
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
    logger.error(errorMessage);
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
    logger.info(`Processing image message from ${userName}`);
    console.log("[Vision] Starting to process image message...");
    const media = await message.downloadMedia();
    if (!media || !media.data) {
      console.log("[Vision] Failed to download media or media data is empty");
      return;
    }

    console.log("[Vision] Image downloaded successfully");

    // Get user's question from message body, remove @gpt and @pro tags
    const userQuestion =
      message.body.replace("@sor", "").replace("@pro", "").trim() ||
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
    const model = message.body.includes("@pro") ? "o4-mini" : "gpt-4.1";

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
    logger.error(errorMessage);
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
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // Array of possible greetings with variations
  const greetings = [
    "gunayd", // Covers: gunaydin, gunaydın
    "günayd", // Covers: günaydın
    "iyi gece", // Covers: iyi geceler
    "ıyi gece", // Covers: ıyi geceler
    "iyi gündüz",
    "iyi günler",
    "ıyi günler",
  ];

  return greetings.some((greeting) => normalizedMsg.includes(greeting));
}

async function handleImageGeneration(message: WAWebJS.Message, prompt: string) {
  try {
    logger.info(`Generating image for prompt: ${prompt}`);

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
      const base64Data = Buffer.from(buffer).toString("base64");

      const media = new MessageMedia(
        "image/jpeg",
        base64Data,
        "generated-image.jpg"
      );

      if (message.fromMe) {
        await message.reply(media);
      } else {
        await client.sendMessage(message.from, media);
      }

      logger.info("Image generated and sent successfully");
    }
  } catch (error) {
    logger.error(`Error generating image: ${error.message}`);
    const errorMessage = "Sorry, there was an error generating the image.";
    if (message.fromMe) message.reply(errorMessage);
    else client.sendMessage(message.from, errorMessage);
  }
}

// Add new daily reminder function
async function sendDailyReminder() {
  try {
    await client.sendMessage("905339388217@c.us", "Ilaclarini al balim");
    logger.info("Daily reminder sent.");
  } catch (error) {
    logger.error("Failed to send daily reminder: " + error.message);
  }
}

client.on("ready", () => {
  console.log("Client is ready!");
  logger.info("WhatsApp client is ready and connected");

  // Schedule morning reminder at 10:00 AM
  cron.schedule("0 10 * * *", () => {
    logger.info("Executing morning reminder job");
    sendDailyReminder();
  }, { timezone: "Europe/Istanbul" });

  // Schedule evening reminder at 19:30 (7:30 PM)
  cron.schedule("30 19 * * *", () => {
    logger.info("Executing evening reminder job");
    sendDailyReminder();
  }, { timezone: "Europe/Istanbul" });
});

client.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
});

// Add new connection status handlers
client.on("disconnected", (reason) => {
  logger.error(`Client was disconnected. Reason: ${reason}`);
});

client.on("authenticated", () => {
  logger.info("Client has been authenticated successfully");
});

initDB().then(() => {
  logger.info("Application starting...");
  client.initialize().catch((error) => {
    logger.error(`Failed to initialize client: ${error.message}`);
  });
});

let messageQueue: WAWebJS.Message[] = [];
let debounceTimer: NodeJS.Timeout | null = null;

client.on("message_create", async (message) => {
  logger.info(`New message received from ${message.from}`);

  if (message.hasQuotedMsg && message.body.includes("@transcribe")) {
    try {
      const quotedMessage = await message.getQuotedMessage();
      if (quotedMessage.type === "ptt" || quotedMessage.type === "audio") {
        logger.info(`Starting transcription for quoted audio message`);
        const media = await quotedMessage.downloadMedia();
        
        if (!media || !media.data) {
          throw new Error("Failed to download audio media");
        }

        // Save base64 audio to temp file
        const tempDir = path.join(__dirname, "temp");
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir);
        }
        const audioPath = path.join(tempDir, `audio_${Date.now()}.ogg`);
        fs.writeFileSync(audioPath, Buffer.from(media.data, "base64"));

        // Transcribe audio
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(audioPath),
          model: "whisper-1",
        });

        // Clean up temp file
        fs.unlinkSync(audioPath);

        // Send transcription
        await message.reply(`Transcription:\n${transcription.text}`);
        logger.info(`Successfully transcribed audio message`);
        return;
      }
    } catch (error) {
      logger.error(`Error transcribing audio: ${error.message}`);
      await message.reply("Sorry, there was an error transcribing the audio message.");
      return;
    }
  }

  // Check availability command first
  if (await handleAvailabilityCommand(message)) {
    logger.info(`Handled availability command from ${message.from}`);
    return;
  }

  // Add voice command handling before other commands
  if (await handleVoiceCommand(message)) {
    logger.info(`Handled voice command from ${message.from}`);
    return;
  }

  // Check if bot is disabled and message is not from admin
  if (!isBotEnabled && !isAdmin(message.from)) {
    if (message.body.includes("@sor")) {
      logger.info(`Rejected message from ${message.from} - bot is disabled`);
      client.sendMessage(message.from, "Sorry, the bot is currently disabled.");
    }
    return;
  }

  // Retrieve user's name, handle undefined
  const contact = await message.getContact();
  const userName = contact.name || "there";
  logger.info(`Processing message from ${userName} (${message.from})`);

  if (message.hasMedia) {
    if (message.type === "ptt") {
      if (message.fromMe) return;
      if (!isVoiceEnabled) {
        logger.info(`Rejected voice message from ${userName} - voice processing is disabled`);
        // client.sendMessage(message.from, "Sorry, voice processing is currently disabled.");
        return;
      }
      logger.info(`Processing voice message from ${userName}`);
      await handleAudioMessage(message, userName);
      return;
    } else if (message.type === "image" && message.body.includes("@sor")) {
      logger.info(`Processing image message from ${userName}`);
      await handleImageMessage(message, userName);
      return;
    }
  }

  if (message.body.startsWith("@draw")) {
    logger.info(`Processing draw request from ${userName}`);
    const prompt = message.body.substring(5).trim();
    await handleImageGeneration(message, prompt);
    return;
  }

  if (
    message.body.includes("@sor") ||
    (containsGreeting(message.body) && message.from == "905339388217@c.us")
  ) {
    logger.info(`Processing GPT request from ${userName}: ${message.body}`);
    const gptResponse = await sendToGPT(message.body, message.from, userName);
    logger.info(`Sending GPT response to ${userName}`);

    try {
      if (message.hasQuotedMsg) {
        const quotedMsg = await message.getQuotedMessage();
        await client.sendMessage(message.from, gptResponse, {
          quotedMessageId: quotedMsg.id._serialized,
        });
      } else {
        await client.sendMessage(message.from, gptResponse);
      }
    } catch (error) {
      console.error("Error sending reply:", error);
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
