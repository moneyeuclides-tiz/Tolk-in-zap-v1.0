const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const express = require('express')
const pino = require('pino')

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const MEU_NUMERO     = (process.env.MEU_NUMERO || '258824410088').replace(/[^0-9]/g, '')
const PORT           = process.env.PORT || 3000
const NOME_BOT       = process.env.NOME_BOT || 'Assistente'

if (!GEMINI_API_KEY) { console.error('❌ GEMINI_API_KEY não definida.'); process.exit(1) }

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY)
const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  systemInstruction: `És um assistente virtual simpático chamado ${NOME_BOT}. Respondes em Português. Nunca uses **, ## ou *.`
})

const app = express()
let codigoPairing = null
let online = false

app.get('/', (req, res) => {
  if (online) return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#000;color:#fff"><h1>✅ Bot Online!</h1></body></html>`)
  if (codigoPairing) return res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#000;color:#fff">
      <h1>📱 Código WhatsApp</h1>
      <p>Insere este código no WhatsApp agora:</p>
      <h2 style="font-size:52px;letter-spacing:10px;color:#25D366;background:#111;padding:24px;border-radius:16px">${codigoPairing}</h2>
      <p style="color:#aaa">Expira em 60 segundos — vai rápido!</p>
    </body></html>
  `)
  return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#000;color:#fff"><h1>⏳ A iniciar...</h1><p>Aguarda 30 segundos e actualiza.</p></body></html>`)
})

app.listen(PORT, () => console.log(`🌐 Servidor na porta ${PORT}`))

const historicos = {}
function adicionarMensagem(userId, role, texto) {
  if (!historicos[userId]) historicos[userId] = []
  historicos[userId].push({ role, parts: [{ text: texto }] })
  if (historicos[userId].length > 20) historicos[userId] = historicos[userId].slice(-20)
}

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_sessao')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, isNewLogin }) => {

    // Pede código quando a ligação está pronta mas ainda não registada
    if (connection === 'open' && !sock.authState.creds.registered) {
      console.log(`📱 A pedir código para: +${MEU_NUMERO}`)
      try {
        const codigo = await sock.requestPairingCode(MEU_NUMERO)
        codigoPairing = codigo
        console.log(`\n🔑 ══════════════════════════════`)
        console.log(`🔑  CÓDIGO: ${codigo}`)
        console.log(`🔑 ══════════════════════════════\n`)
      } catch (err) {
        console.error('❌ Erro ao pedir código:', err.message)
      }
    }

    if (connection === 'open' && sock.authState.creds.registered) {
      online = true
      codigoPairing = null
      console.log('✅ WhatsApp conectado! Bot a funcionar.')
    }

    if (connection === 'close') {
      online = false
      const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (codigo !== DisconnectReason.loggedOut) {
        console.log('🔄 A reconectar...')
        setTimeout(iniciarBot, 5000)
      } else {
        console.log('❌ Sessão terminada.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg?.message || msg.key.fromMe) return
    const userId = msg.key.remoteJid
    if (userId.includes('@g.us')) return

    const texto = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim()
    if (!texto) return

    console.log(`📨 ${userId.replace('@s.whatsapp.net', '')}: ${texto}`)

    try {
      await sock.sendPresenceUpdate('composing', userId)
      adicionarMensagem(userId, 'user', texto)

      const chat = model.startChat({ history: (historicos[userId] || []).slice(0, -1) })
      const resultado = await chat.sendMessage(texto)
      const resposta = resultado.response.text().trim()

      adicionarMensagem(userId, 'model', resposta)
      await sock.sendPresenceUpdate('paused', userId)
      await sock.sendMessage(userId, { text: resposta }, { quoted: msg })

    } catch (erro) {
      console.error('❌ Erro:', erro.message)
      await sock.sendMessage(userId, { text: 'Desculpa, tive um problema. Tenta novamente!' })
    }
  })
}

iniciarBot().catch(console.error)
process.on('uncaughtException', err => console.error('❗', err.message))
process.on('unhandledRejection', err => console.error('❗', err?.message || err))
