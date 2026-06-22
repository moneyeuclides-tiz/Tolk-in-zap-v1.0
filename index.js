const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const express = require('express')
const pino = require('pino')

// ============================================================
// CONFIGURAÇÃO
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const MEU_NUMERO     = process.env.MEU_NUMERO || '258824410088'
const PORT           = process.env.PORT || 3000
const NOME_BOT       = process.env.NOME_BOT || 'Assistente'
const MAX_HISTORICO  = parseInt(process.env.MAX_HISTORICO || '20', 10)
const MAX_RECONNECT_DELAY_MS = 60_000

if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY não definida.')
  process.exit(1)
}

// ============================================================
// GEMINI AI
// ============================================================
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY)
const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  systemInstruction: `És um assistente virtual simpático chamado ${NOME_BOT}.
Respondes sempre em Português claro e conciso.
Nunca uses símbolos markdown como **, ## ou *.
Sê directo, amigável e prestativo.`
})

// ============================================================
// SERVIDOR WEB
// ============================================================
const app = express()
let codigoPairing = null
let online = false
let ultimaAtividade = Date.now()

app.get('/', (req, res) => {
  if (online) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
        <h1>✅ Bot Online!</h1>
        <p>WhatsApp conectado e a funcionar.</p>
        <p style="color:#666;font-size:12px">Última actividade: ${new Date(ultimaAtividade).toLocaleString('pt-PT')}</p>
      </body></html>
    `)
  }
  if (codigoPairing) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
        <h1>📱 Código de Associação</h1>
        <p>Insere este código no WhatsApp:</p>
        <h2 style="font-size:48px;letter-spacing:8px;color:#25D366;background:#111;padding:20px;border-radius:12px">${codigoPairing}</h2>
        <p style="color:#aaa">WhatsApp → Dispositivos ligados → Associar com número → inserir este código</p>
      </body></html>
    `)
  }
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
      <h1>⏳ A gerar código...</h1>
      <p>Aguarda 30 segundos e actualiza a página.</p>
    </body></html>
  `)
})

// Endpoint simples de saúde, útil para serviços de keep-alive (ex: UptimeRobot)
app.get('/health', (req, res) => {
  res.json({ online, uptime: process.uptime() })
})

app.listen(PORT, () => {
  console.log(`🌐 Servidor activo na porta ${PORT}`)
})

// ============================================================
// HISTÓRICO DE CONVERSAS
// ============================================================
const historicos = {}

function adicionarMensagem(userId, role, texto) {
  if (!historicos[userId]) historicos[userId] = []
  historicos[userId].push({ role, parts: [{ text: texto }] })
  if (historicos[userId].length > MAX_HISTORICO) {
    historicos[userId] = historicos[userId].slice(-MAX_HISTORICO)
  }
}

// ============================================================
// BOT WHATSAPP
// ============================================================
let tentativasReconexao = 0

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_sessao')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsApp AI Bot', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 30_000,
  })

  // Pede código de associação por número (em vez de QR)
  if (!sock.authState.creds.registered) {
    const numero = MEU_NUMERO.replace(/[^0-9]/g, '')
    console.log(`📱 A gerar código para o número: +${numero}`)

    await new Promise(resolve => setTimeout(resolve, 3000)) // espera ligação

    try {
      const codigo = await sock.requestPairingCode(numero)
      codigoPairing = codigo
      console.log(`\n🔑 ==========================================`)
      console.log(`🔑 CÓDIGO DE ASSOCIAÇÃO: ${codigo}`)
      console.log(`🔑 Insere este código no WhatsApp!`)
      console.log(`🔑 ==========================================\n`)
    } catch (err) {
      console.error('❌ Erro ao gerar código:', err.message)
    }
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      online = false
      const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`🔌 Conexão fechada — código: ${codigo}`)

      if (codigo !== DisconnectReason.loggedOut) {
        tentativasReconexao++
        const delay = Math.min(5000 * tentativasReconexao, MAX_RECONNECT_DELAY_MS)
        console.log(`🔄 A reconectar em ${delay / 1000}s (tentativa ${tentativasReconexao})...`)
        setTimeout(iniciarBot, delay)
      } else {
        console.log('❌ Sessão terminada (logged out). Apaga a pasta auth_sessao e reinicia para gerar novo código.')
      }
    }

    if (connection === 'open') {
      online = true
      codigoPairing = null
      tentativasReconexao = 0
      ultimaAtividade = Date.now()
      console.log('✅ WhatsApp conectado! Bot a funcionar.')
    }
  })

  // ============================================================
  // RESPONDE MENSAGENS COM GEMINI
  // ============================================================
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    const msg = messages[0]
    if (!msg?.message || msg.key.fromMe) return

    const userId = msg.key.remoteJid
    if (!userId || userId.includes('@g.us') || userId === 'status@broadcast') return

    const texto = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''
    ).trim()

    if (!texto) return

    ultimaAtividade = Date.now()
    console.log(`📨 [${userId.replace('@s.whatsapp.net', '')}]: ${texto}`)

    try {
      await sock.sendPresenceUpdate('composing', userId)

      adicionarMensagem(userId, 'user', texto)

      const historico = historicos[userId] || []
      const chat = model.startChat({
        history: historico.slice(0, -1),
      })

      const resultado = await chat.sendMessage(texto)
      const resposta = resultado.response.text().trim()

      adicionarMensagem(userId, 'model', resposta)

      await sock.sendPresenceUpdate('paused', userId)
      await sock.sendMessage(userId, { text: resposta }, { quoted: msg })

      console.log(`✅ Resposta enviada`)

    } catch (erro) {
      console.error('❌ Erro ao processar mensagem:', erro.message)
      try {
        await sock.sendPresenceUpdate('paused', userId)
        await sock.sendMessage(userId, {
          text: 'Desculpa, tive um problema. Tenta novamente!'
        })
      } catch (erroEnvio) {
        console.error('❌ Erro ao enviar mensagem de falha:', erroEnvio.message)
      }
    }
  })
}

iniciarBot().catch(err => {
  console.error('❌ Erro fatal ao iniciar bot:', err)
  process.exit(1)
})

process.on('uncaughtException', err => console.error('❗ uncaughtException:', err.message))
process.on('unhandledRejection', err => console.error('❗ unhandledRejection:', err?.message || err))
