import puppeteer from 'puppeteer'

const BANK_LOGIN_URL = 'https://login.portales.bancochile.cl/login'
const BANK_PRODUCTS_URL = 'https://portalpersonas.bancochile.cl/mibancochile/rest/persona/bff-ppersonas-prd-selector/productos/obtenerProductos?incluirTarjetas=true'
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

const getCreditCardsIds = async (cookies) => {
    const response = await fetch(BANK_PRODUCTS_URL, {
        headers: {
            'cookie': cookies
        }
    })

    const data = await response.json()

    const creditCardsIds = data.productos
        .filter(product => product.codigo === 'TNM')
        .map(product => product.id)

    return creditCardsIds
}

const app = async () => {
    console.log('[+] Obteniendo cookies')
    const cookies = await getCookies()

    console.log('[+] Obteniendo tarjetas de crédito')
    const creditCardsIds = await getCreditCardsIds(cookies)
    console.log('\t[=] Tarjetas de crédito encontradas:', creditCardsIds.join(', '))
}

await app()