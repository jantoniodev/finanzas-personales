import puppeteer from 'puppeteer'

const BANK_LOGIN_URL = 'https://login.portales.bancochile.cl/login'
const BANK_PRODUCTS_URL = 'https://portalpersonas.bancochile.cl/mibancochile/rest/persona/bff-ppersonas-prd-selector/productos/obtenerProductos?incluirTarjetas=true'
const BANK_BILLING_DATES = 'https://portalpersonas.bancochile.cl/mibancochile/rest/persona/tarjetas/estadocuenta/fechas-facturacion'
const BANK_NOT_BILLED_MOVEMENTS = 'https://portalpersonas.bancochile.cl/mibancochile/rest/persona/tarjeta-credito-digital/movimientos-no-facturados'
const BANK_USD_PRICE = 'https://portalpersonas.bancochile.cl/mibancochile/rest/persona/home/indices-financieros'
const BANK_BILLED_NATIONAL_MOVEMENTS = 'https://portalpersonas.bancochile.cl/mibancochile/rest/persona/tarjetas/estadocuenta/nacional/resumen-por-fecha'
const BANK_BILLED_INTERNATIONAL_MOVEMENTS = 'https://portalpersonas.bancochile.cl/mibancochile/rest/persona/tarjetas/estadocuenta/internacional/resumen-por-fecha'
const BANK_USER = process.env.BANK_USER
const BANK_PASSWORD = process.env.BANK_PASSWORD

const MORE_THAN_TWO_SPACES_REGEX = /\s{2,}/g

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

const getBillingDates = async (cookies, cardId) => {
    const response = await fetch(BANK_BILLING_DATES, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'cookie': cookies
        },
        body: JSON.stringify({
            idTarjeta: cardId
        })
    })

    const data = await response.json()

    const internationalBillingDate = data.listaInternacional.map(date => date.fechaFacturacion)
    const nationalBillingDate = data.listaNacional.map(date => date.fechaFacturacion)
    const accountNumber = data.numeroCuenta

    return {
        internationalBillingDate,
        nationalBillingDate,
        accountNumber,
    }
}

const getNationalBilledMovements = async (cookies, cardId, billingDate, accountNumber) => {
    const response = await fetch(BANK_BILLED_NATIONAL_MOVEMENTS, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'cookie': cookies
        },
        body: JSON.stringify({
            idTarjeta: cardId,
            fechaFacturacion: billingDate,
            numeroCuenta: accountNumber
        })
    })

    const data = await response.json()

    return [
            ...data.seccionOperaciones.transaccionesTarjetas,
            ...data.seccionComprasEnCuotas.transaccionesTarjetas
        ]
        .filter(transaction => transaction.totales === false)
        .map(transaction => {
            return {
                type: 'national',
                amount: transaction.montoTransaccion,
                date: transaction.fechaTransaccion,
                description: transaction.descripcion.replaceAll(MORE_THAN_TWO_SPACES_REGEX, ' '),
                installment: parseInt(transaction.cuotas.split('/')[0]) || 1,
                totalInstallments: parseInt(transaction.cuotas.split('/')[1]) || 1,
            }
        })
}

const getNotBilledMovements = async (cookies, cardId) => {
    const response = await fetch(BANK_NOT_BILLED_MOVEMENTS, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'cookie': cookies
        },
        body: JSON.stringify({
            idTarjeta: cardId
        })
    })

    const data = await response.json()

    return data.listaMovNoFactur
        .filter(movement => movement.montoCompra >= 0)
        .map(movement => {
            return {
                type: movement.origenTransaccion === 'NAC' ? 'national' : 'international',
                amount: movement.montoCompra,
                date: movement.fechaTransaccion,
                description: movement.glosaTransaccion.replaceAll(MORE_THAN_TWO_SPACES_REGEX, ' '),
                installment: parseInt(movement.numeroCuotas),
                totalInstallments: parseInt(movement.numeroTotalCuotas === '0' ? '1' : movement.numeroTotalCuotas),
            }
        })
}

const getUsdPrice = async (cookies) => {
    const response = await fetch(BANK_USD_PRICE, {
        headers: {
            'cookie': cookies
        }
    })

    const data = await response.json()

    return data.datosObservados

}

const calculateTotalBilledAmount = (billedMovements, usdPrice) => {
    return billedMovements
        .reduce((total, movement) => 
            movement.type === 'national'
            ? total + (movement.amount / movement.totalInstallments)
            : total + (movement.amount / movement.totalInstallments * usdPrice)
        , 0)
}

const calculateInstallmentsTotals = (billedMovements) => {
    return billedMovements
        .reduce((total, movement) => {
            if(movement.totalInstallments === 1) {
                return total
            }

            if(movement.installment === movement.totalInstallments) {
                return total
            }

            return total + movement.amount
        }, 0)
}

const formatAmount = (amount) => {
    return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(amount)
}

const app = async () => {
    console.log('[+] Obteniendo cookies')
    const cookies = await getCookies()

    const usdPrice = await getUsdPrice(cookies)
    console.log('[+] Precio del dólar:', usdPrice)

    console.log('[+] Obteniendo tarjetas de crédito')
    const creditCardsIds = await getCreditCardsIds(cookies)
    console.log('\t[=] Tarjetas de crédito encontradas:', creditCardsIds.join(', '))

    for (const cardId of creditCardsIds) {
        console.log(`[+] Tarjeta de crédito: ${cardId}`)

        console.log(`\t[+] Obteniendo movimientos no facturados`)
        const notBilledMovements = await getNotBilledMovements(cookies, cardId)

        const totalBilledAmount = calculateTotalBilledAmount(notBilledMovements, usdPrice)
        console.log(`\t[=] Total movimientos no facturados: ${formatAmount(totalBilledAmount)}`)

        console.log(`\t[+] Obteniendo fechas de facturación`)
        const { nationalBillingDate, accountNumber } = await getBillingDates(cookies, cardId)

        console.log(`\t[+] Obteniendo movimientos facturados nacionales`)
        const nationalBilledMovements = await getNationalBilledMovements(cookies, cardId, nationalBillingDate[0], accountNumber)

        const totalInstallments = calculateInstallmentsTotals(nationalBilledMovements)
        console.log(`\t[=] Total cuotas: ${formatAmount(totalInstallments)}`)
    }
}

await app()