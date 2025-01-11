import WAWebJS, { Client, LocalAuth, MessageMedia } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import OpenAI from "openai";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fs from "fs";
import path from "path";
import { ElevenLabsClient } from "elevenlabs"; // Added ElevenLabsClient import

const ADMIN_NUMBER = "491627609755@c.us";
const SYSTEM_PROMPT_PATH = path.join(__dirname, "system-prompt.txt");

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
});

const openai = new OpenAI();
const elevenlabs = new ElevenLabsClient();

let db: any;
async function initDB() {
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
}

async function sendToGPT(message: string, from: string, userName: string) {
  const storedMessages = await db.all(
    "SELECT role, content FROM conversation WHERE user = ? ORDER BY id",
    [from]
  );
  storedMessages.push({
    role: "user",
    content: [{ type: "text", text: `${userName}: ` + message }],
  });

  // Initialize messages with system prompt and user name
  const systemPrompt = {
    role: "system",
    content: await loadSystemPrompt(),
  };
  const messages = [systemPrompt, ...storedMessages];

  // Choose model based on message content
  const model = message.includes("@pro") ? "o1-preview" : "gpt-4o-mini";

  const completion = await openai.chat.completions.create({
    model: model,
    messages: messages,
  });
  const responseContent = completion.choices[0].message.content;
  await db.run(
    "INSERT INTO conversation(user, role, content) VALUES(?, ?, ?)",
    [from, "user", JSON.stringify([{ type: "text", text: message }])]
  );
  await db.run(
    "INSERT INTO conversation(user, role, content) VALUES(?, ?, ?)",
    [from, "assistant", JSON.stringify(responseContent)]
  );
  return responseContent;
}

async function handleAudioMessage(message: WAWebJS.Message, userName: string) {
  try {
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
    console.error("[Audio] Error processing audio:", error);
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
    console.error("[Vision] Error processing image:", error);
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

client.on("ready", () => {
  console.log("Client is ready!");
});

client.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
});

initDB().then(() => {
  client.initialize();
});

let messageQueue: WAWebJS.Message[] = [];
let debounceTimer: NodeJS.Timeout | null = null;

client.on("message_create", async (message) => {
  // Retrieve user's name, handle undefined
  const contact = await message.getContact();
  const userName = contact.name || "there";
  console.log(message.from, userName);
  // Add admin command handling
  if (message.from === ADMIN_NUMBER && message.body.startsWith("@system")) {
    const newPrompt = message.body.substring("@system".length).trim();
    if (newPrompt) {
      await saveSystemPrompt(newPrompt);

      if (message.fromMe)
        message.reply("System prompt updated and saved to file!");
      else
        client.sendMessage(
          message.from,
          "System prompt updated and saved to file!",
          {}
        );
    } else {
      const currentPrompt = await loadSystemPrompt();
      client.sendMessage(
        message.from,
        "Current system prompt:\n" + currentPrompt
      );
    }
    return;
  }

  if (message.hasMedia) {
    if (message.type === "ptt") {
      if (message.fromMe) return;

      await handleAudioMessage(message, userName);
      return;
    } else if (message.type === "image" && message.body.includes("@gpt")) {
      await handleImageMessage(message, userName);
      return;
    }
  }

  if (message.body.includes("@gpt")) {
    const gptResponse = await sendToGPT(message.body, message.from, userName);

    if (message.fromMe) message.reply(gptResponse);
    else client.sendMessage(message.from, gptResponse);
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
