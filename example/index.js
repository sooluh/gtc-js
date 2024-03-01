// const { Gtc } = require('../dist')
const { Gtc } = require('gtc-js')
const qrcode = require('qrcode-terminal')

const main = async () => {
  const gtc = new Gtc({
    cookiePath: './cookie.json',
    showQr: false,
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ignoreDefaultArgs: ['--disable-extensions'],
    },
  })

  gtc.on('qrcode', (value) => {
    qrcode.generate(value, { small: true })
  })

  gtc.on('logged', (logged) => {
    if (logged) {
      console.log('logged')
    } else {
      console.log('scan qr code first')
    }
  })

  gtc.on('error', (error) => {
    console.error(error)
  })

  await gtc.init()

  const tags = await gtc.find('ID', '6283861415641') // just random phone number
  console.log(tags)
}

main()
