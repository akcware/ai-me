A WhatsApp bot that provides AI-powered interactions using OpenAI's GPT models, voice processing, and image analysis capabilities.

> 🏆 **Award-winning project**: 3rd Place at [Nosu AI Hackathon](https://devpost.com/software/twinify-your-ai-powered-digital-twin-for-whatsapp) in "Exploratory use of LLMs and Vision models" category ($500 Nebius)

## Features

- **Chat with GPT**: Talk to OpenAI's models through WhatsApp
- **Voice Messaging**: Send voice messages and receive voice replies (transcription and text-to-speech)
- **Image Analysis**: Send images with the "@gpt" tag to get AI descriptions
- **Image Generation**: Create AI images with the "@draw" command
- **Voice Transcription**: Transcribe voice messages with "@transcribe"
- **Daily Reminders**: Automated medication reminders
- **Admin Controls**: Enable/disable bot functionality remotely

## Technologies

- WhatsApp Web.js for WhatsApp integration
- OpenAI API for GPT models, Whisper (voice transcription), and image processing
- ElevenLabs for text-to-speech generation
- SQLite for conversation storage
- Express for log monitoring

## Installation

1. Clone this repository
2. Install dependencies:

```bash
bun install
```

3. Create a .env.local file with the following variables:
   - OPENAI_API_KEY
   - ELEVENLABS_API_KEY
   - ADMIN_NUMBER (your WhatsApp number)

## Running the Bot

Start the application:

```bash
bun run index.ts
```

Scan the QR code with WhatsApp to link your account.

## Usage Commands

- `@status` - Check if bot is enabled
- `@enable` - Enable bot (admin only)
- `@disable` - Disable bot (admin only)
- `@draw [prompt]` - Generate an image
- `@sor [message]` - Force GPT response for a message
- `@pro [message]` - Use advanced GPT model
- `@transcribe` - Reply to a voice message to get transcription

## Log Monitoring

The application includes a built-in log server that can be accessed at:
```
http://localhost:3000/logs
```

## Development

This project uses Bun as the JavaScript/TypeScript runtime. The database automatically stores conversation history for context-aware responses.

## Awards

- **3rd Place** - [Nosu AI Hackathon](https://devpost.com/software/twinify-your-ai-powered-digital-twin-for-whatsapp) in the category of "Winner Exploratory use of LLMs and Vision models" ($500 Nebius)