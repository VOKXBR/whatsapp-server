const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const activeSessions = new Map();

async function createWhatsAppConnection(userId) {
  const sessionPath = path.join(__dirname, 'sessions', userId);
  
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['VOKXBR', 'Chrome', '1.0.0']
  });

  let qrCodeData = null;
  let connectionStatus = 'connecting';
  let phoneNumber = null;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await qrcode.toDataURL(qr);
      connectionStatus = 'qr_ready';
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      
      if (shouldReconnect) {
        connectionStatus = 'reconnecting';
        setTimeout(() => createWhatsAppConnection(userId), 3000);
      } else {
        connectionStatus = 'disconnected';
        activeSessions.delete(userId);
        
        // Limpar sessão
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }
      }
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      qrCodeData = null;
      phoneNumber = sock.user?.id?.split(':')[0];
      
      // Webhook de conexão estabelecida
      console.log(`✅ WhatsApp conectado: ${phoneNumber}`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  activeSessions.set(userId, {
    sock,
    getQR: () => qrCodeData,
    getStatus: () => connectionStatus,
    getPhone: () => phoneNumber
  });

  return { qrCodeData, connectionStatus };
}

// Gerar QR Code
app.post('/generate-qr', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId é obrigatório' });
    }

    const result = await createWhatsAppConnection(userId);
    
    res.json({
      qrCode: result.qrCodeData,
      status: result.connectionStatus
    });
  } catch (error) {
    console.error('Erro ao gerar QR:', error);
    res.status(500).json({ error: error.message });
  }
});

// Status da conexão
app.get('/status/:userId', (req, res) => {
  const { userId } = req.params;
  const session = activeSessions.get(userId);

  if (!session) {
    return res.json({
      connected: false,
      status: 'disconnected'
    });
  }

  res.json({
    connected: session.getStatus() === 'connected',
    status: session.getStatus(),
    phoneNumber: session.getPhone(),
    qrCode: session.getQR()
  });
});

// Enviar mensagem
app.post('/send-message', async (req, res) => {
  try {
    const { userId, to, message } = req.body;
    const session = activeSessions.get(userId);

    if (!session || session.getStatus() !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não está conectado' });
    }

    const formattedNumber = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await session.sock.sendMessage(formattedNumber, { text: message });

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    res.status(500).json({ error: error.message });
  }
});

// Desconectar
app.post('/disconnect', async (req, res) => {
  try {
    const { userId } = req.body;
    const session = activeSessions.get(userId);

    if (session) {
      await session.sock.logout();
      activeSessions.delete(userId);
      
      const sessionPath = path.join(__dirname, 'sessions', userId);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
