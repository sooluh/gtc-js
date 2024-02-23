const { Gtc } = require('../dist')
const qrcode = require('qrcode-terminal')

const main = async () => {
  const gtc = new Gtc({ cookiePath: './cookie.json', showQr: false })

  gtc.on('qrcode', (value) => {
    qrcode.generate(value, { small: true })
  })

  await gtc.init()

  const tags = await gtc.find('ID', '6283109871234') // just random phone number
  console.log(tags)
}

main()
