const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const express = require('express')
const pino = require('pino')

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const MEU_NUMERO     = (process.env.MEU_NUMERO || '258824410088').replace(/[^0-9]/g, '')
const PORT           = process.env.PORT || 3000
const NOME_BOT       = process.env.NOME_BOT || 'Assistente'

if (!GEMINI_API_KEY) { console.error('GEMINI_API_KEY nao definida.'); process.exit(1) }

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY)
const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  systemInstruction: `Es um assistente simpatico chamado ${NOME_BOT}. Respondes em Portugues. Sem markdown.`
})

const app = express()
let codigoPairing = null
let online = false

app.get('/', (req, res) => {
  if (online) return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#000;color:#fff"><h1>Bot Online!</h1></body></html>')
  if (codigoPairing) return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#000;color:#fff"><h1>Codigo WhatsApp</h1><h2 style="font-size:52px;letter-spacing:10px;color:#25D366;background:#111;padding:24px;border-radius:16px">${codigoPairing}</h2><p>Expira em 60 segundos!</p></body></html>`)
  return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#000;color:#fff"><h1>A iniciar...</h1><p>Aguarda e actualiza.</p></body></html>')
})

app.listen(PORT, () => console.log('Servidor na porta ' + PORT))

const historicos = {}

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_sessao')
  const { version, isLatest } = await fetchLatestBaileysVersion()
  console.log('Versao WhatsApp: ' + version.join('.') + ' | Latest: ' + isLatest)

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsApp Web', 'Chrome', '124.0.6367.82'],
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 20_000,
  })

  sock.ev.on('creds.update', saveCreds)

  let codigoPedido = false

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    console.log('Estado: ' + connection)

    if (connection === 'open') {
      if (!sock.authState.creds.registered && !codigoPedido) {
        codigoPedido = true
        try {
          await new Promise(r => setTimeout(r, 3000))
          const codigo = await sock.requestPairingCode(MEU_NUMERO)
          codigoPairing = codigo
          console.log('CODIGO: ' + codigo)
        } catch (err) {
          console.error('Erro codigo: ' + err.message)
          codigoPedido = false
        }
      }
      if (sock.authState.creds.registered) {
        online = true
        codigoPairing = null
        console.log('Bot online!')
      }
    }

    if (connection === 'close') {
      online = false
      codigoPedido = false
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log('Fechado. Codigo: ' + statusCode)
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log('Reconectar em 5s...')
        setTimeout(iniciarBot, 5000)
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
    try {
      await sock.sendPresenceUpdate('composing', userId)
      if (!historicos[userId]) historicos[userId] = []
      historicos[userId].push({ role: 'user', parts: [{ text: texto }] })
      if (historicos[userId].length > 20) historicos[userId] = historicos[userId].slice(-20)
      const chat = model.startChat({ history: historicos[userId].slice(0, -1) })
      const resultado = await chat.sendMessage(texto)
      const resposta = resultado.response.text().trim()
      historicos[userId].push({ role: 'model', parts: [{ text: resposta }] })
      await sock.sendPresenceUpdate('paused', userId)
      await sock.sendMessage(userId, { text: resposta }, { quoted: msg })
    } catch (erro) {
      console.error('Erro: ' + erro.message)
      await sock.sendMessage(userId, { text: 'Desculpa, tente novamente!' })
    }
  })
}

iniciarBot().catch(err => {
  console.error('Erro fatal: ' + err.message)
  setTimeout(iniciarBot, 10000)
})

process.on('uncaughtException', err => console.error(err.message))
process.on('unhandledRejection', err => console.error(err?.message || err))
