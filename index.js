const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const express = require('express')
const qrcode = require('qrcode')
const pino = require('pino')

// ============================================================
// CONFIGURAÇÃO — variáveis de ambiente (Railway)
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const MEU_NUMERO    = process.env.MEU_NUMERO || '258824410088'
const PORT          = process.env.PORT || 3000
const NOME_BOT      = process.env.NOME_BOT || 'Assistente'

if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY não definida. Adiciona nas variáveis de ambiente.')
  process.exit(1)
}

// ============================================================
// GEMINI AI
// ============================================================
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY)
const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  systemInstruction: `És um assistente virtual simpático e útil chamado ${NOME_BOT}.
Respondes sempre em Português claro e conciso.
Nunca uses símbolos de markdown como **, ## ou * — só texto simples.
Sê directo, amigável e prestativo.
Quando não souberes algo, diz honestamente que não sabes.`
})

// ============================================================
// SERVIDOR WEB — obrigatório para Railway + mostra QR code
// ============================================================
const app = express()
let qrAtual   = null
let online    = false
let iniciando = true

app.get('/', async (req, res) => {
  if (online) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h1>✅ Bot Online!</h1>
        <p>O WhatsApp AI Bot está activo e a responder mensagens.</p>
        <p>Número: +${MEU_NUMERO}</p>
      </body></html>
    `)
  }
  if (qrAtual) {
    const qrImg = await qrcode.toDataURL(qrAtual)
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h1>📱 Escaneia o QR Code</h1>
        <p>WhatsApp → Menu ⋮ → Dispositivos ligados → Ligar dispositivo</p>
        <img src="${qrImg}" style="width:280px;height:280px;border:2px solid #ccc;border-radius:12px"/>
        <p><small>Atualiza a página se o QR expirar</small></p>
      </body></html>
    `)
  }
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h1>⏳ A iniciar...</h1>
      <p>Aguarda 30 segundos e atualiza a página.</p>
    </body></html>
  `)
})

app.listen(PORT, () => {
  console.log(`🌐 Servidor activo na porta ${PORT}`)
})

// ============================================================
// HISTÓRICO DE CONVERSAS
// ============================================================
const historicos = {}
const MAX_MENSAGENS = 20 // máximo de mensagens guardadas por utilizador

function obterHistorico(userId) {
  if (!historicos[userId]) historicos[userId] = []
  return historicos[userId]
}

function adicionarAoHistorico(userId, role, texto) {
  const h = obterHistorico(userId)
  h.push({ role, parts: [{ text: texto }] })
  // Mantém só as últimas MAX_MENSAGENS
  if (h.length > MAX_MENSAGENS) {
    historicos[userId] = h.slice(-MAX_MENSAGENS)
  }
}

// ============================================================
// BOT WHATSAPP
// ============================================================
async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_sessao')
  const { version }          = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsApp AI Bot', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 30_000,
  })

  sock.ev.on('creds.update', saveCreds)

  // --- EVENTOS DE CONEXÃO ---
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrAtual = qr
      online  = false
      console.log('📱 QR Code pronto — abre a URL do Railway para escanear')
    }

    if (connection === 'close') {
      online = false
      const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`🔌 Conexão fechada — código: ${codigo}`)

      if (codigo === DisconnectReason.loggedOut) {
        console.log('❌ Sessão terminada. Apaga a pasta auth_sessao e reinicia.')
      } else {
        console.log('🔄 A reconectar em 5 segundos...')
        setTimeout(iniciarBot, 5000)
      }
    }

    if (connection === 'open') {
      online  = true
      qrAtual = null
      console.log('✅ WhatsApp conectado! Bot a funcionar.')
    }
  })

  // --- MENSAGENS RECEBIDAS ---
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    const msg = messages[0]
    if (!msg?.message || msg.key.fromMe) return

    const userId = msg.key.remoteJid
    if (userId.includes('@g.us')) return // ignora grupos

    // Extrai texto da mensagem
    const texto = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      ''
    ).trim()

    if (!texto) return

    console.log(`📨 [${userId.replace('@s.whatsapp.net', '')}]: ${texto}`)

    try {
      // Mostra "a escrever..."
      await sock.sendPresenceUpdate('composing', userId)

      // Adiciona mensagem do utilizador ao histórico
      adicionarAoHistorico(userId, 'user', texto)

      // Chama o Gemini com histórico completo
      const historico = obterHistorico(userId)
      const chat = model.startChat({
        history: historico.slice(0, -1), // histórico sem a última mensagem
      })

      const resultado = await chat.sendMessage(texto)
      const resposta  = resultado.response.text().trim()

      // Adiciona resposta do bot ao histórico
      adicionarAoHistorico(userId, 'model', resposta)

      // Para de mostrar "a escrever..." e envia resposta
      await sock.sendPresenceUpdate('paused', userId)
      await sock.sendMessage(userId, { text: resposta }, { quoted: msg })

      console.log(`✅ Resposta enviada`)

    } catch (erro) {
      console.error('❌ Erro ao gerar resposta:', erro.message)
      await sock.sendPresenceUpdate('paused', userId)
      await sock.sendMessage(userId, {
        text: 'Desculpa, tive um problema ao processar. Tenta novamente!'
      })
    }
  })
}

// ============================================================
// INICIA TUDO
// ============================================================
iniciarBot().catch(console.error)

// Previne crash por erros não tratados
process.on('uncaughtException',  err => console.error('❗ Erro não capturado:', err.message))
process.on('unhandledRejection', err => console.error('❗ Promise rejeitada:', err?.message || err))
