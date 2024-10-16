import puppeteer from 'puppeteer'

const BANK_LOGIN_URL = 'https://login.portales.bancochile.cl/login'
const BANK_USER = process.env.BANK_USER
const BANK_PASSWORD = process.env.BANK_PASSWORD

const formatCookies = (cookies) => {
    return cookies.map(cookie => {
        return `${cookie.name}=${cookie.value}`
    }).join('; ')
}

const getCookies = async () => {
    const browser = await puppeteer.launch({ headless: false })
    const page = await browser.newPage()

    await page.setViewport({ width: 1280, height: 800 })

    await page.goto(BANK_LOGIN_URL)

    await page.locator('#iduserName').fill(BANK_USER)
    await page.locator('#password').fill(BANK_PASSWORD)
    await page.locator('#idIngresar').click()

    await page.waitForNavigation()

    const cookies = await page.cookies()

    await browser.close()

    const formattedCookies = formatCookies(cookies)
    return formattedCookies
}

const app = async () => {
    console.log('[+] Obteniendo cookies')
    const cookies = await getCookies()


}

await app()