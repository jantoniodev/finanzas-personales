import puppeteer from 'puppeteer'
import { randomUUID } from 'crypto'
import chalk from 'chalk'
import fs from 'fs/promises'
import { read } from 'fs'

const BANK_LOGIN_URL = 'https://login.portales.bancochile.cl/login'
const BANK_PRODUCTS_URL = 'https://portalpersonas.bancochile.cl/mibancochile/rest/persona/bff-ppersonas-prd-selector/productos/obtenerProductos?incluirTarjetas=true'
const BANK_BILLING_DATES = 'https://portalpersonas.bancochile.cl/mibancochile/rest/persona/tarjetas/estadocuenta/fechas-facturacion'
const BANK_NOT_BILLED_MOVEMENTS = 'https://portalpersonas.bancochile.cl/mibancochile/rest/persona/tarjeta-credito-digital/movimientos-no-facturados'
const BANK_USD_PRICE = 'https://portalpersonas.bancochile.cl/mibancochile/rest/persona/home/indices-financieros'
const BANK_BILLED_NATIONAL_MOVEMENTS = 'https://portalpersonas.bancochile.cl/mibancochile/rest/persona/tarjetas/estadocuenta/nacional/resumen-por-fecha'
const BANK_BILLED_INTERNATIONAL_MOVEMENTS = 'https://portalpersonas.bancochile.cl/mibancochile/rest/persona/tarjetas/estadocuenta/internacional/resumen-por-fecha'
const AMOUNT_TOLERANCE = 0.6
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

const getCreditCards = async (cookies) => {
    const response = await fetch(BANK_PRODUCTS_URL, {
        headers: {
            'cookie': cookies
        }
    })

    const data = await response.json()

    const creditCards = data.productos
        .filter(product => product.codigo === 'TNM')
        .map(product => ({
            id: product.id,
            name: product.descripcionLogo.trim(),
            number: product.mascara.replaceAll('*', '').trim()
        }))

    return creditCards
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

const getNationalBilledResume = async (cookies, cardId, billingDate, accountNumber) => {
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

    return parseInt(data.resumen.montoFacturado)
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
                id: randomUUID(),
                type: 'national',
                amount: transaction.montoTransaccion,
                date: transaction.fechaTransaccion,
                description: transaction.descripcion.replaceAll(MORE_THAN_TWO_SPACES_REGEX, ' '),
                installment: parseInt(transaction.cuotas.split('/')[0]) || 1,
                totalInstallments: parseInt(transaction.cuotas.split('/')[1]) || 1,
            }
        })
}

const getInternationalBilledResume = async (cookies, cardId, billingDate, accountNumber) => {
    const response = await fetch(BANK_BILLED_INTERNATIONAL_MOVEMENTS, {
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

    if(!data?.resumen?.montoFacturado) {
        return 0
    }

    return parseInt(data.resumen.montoFacturado)
}

const getInternationalBilledMovements = async (cookies, cardId, billingDate, accountNumber) => {
    const response = await fetch(BANK_BILLED_INTERNATIONAL_MOVEMENTS, {
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

    return (data.seccionCompras?.transaccionesTarjetas || [])
        .filter(transaction => transaction.totales === false)
        .map(transaction => {
            return {
                id: randomUUID(),
                type: 'international',
                amount: transaction.montoDolar,
                date: transaction.fechaTransaccion,
                description: transaction.descripcion.replaceAll(MORE_THAN_TWO_SPACES_REGEX, ' '),
                installment: 1,
                totalInstallments: 1,
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
                id: randomUUID(),
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

const calculatePeriodicMovementsAmount = (periodicMovements, usdPrice) => {
    return periodicMovements
        .reduce((total, movement) => 
            movement.type === 'national'
            ? total + movement.amount
            : total + (movement.amount * usdPrice)
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

const compareAmount = (amountA, amountB, tolerance) => {
    return Math.abs(amountA - amountB) <= tolerance
}

const compareDescriptions = (descriptionA, descriptionB) => {
    const descriptionAWords = descriptionA.split(' ')

    const commonWords = descriptionAWords.filter(word => descriptionB.includes(word))

    return commonWords.length >= 1
}

const compareMovements = (movementA, movementB) => {
    const areAmountEqual = compareAmount(movementA.amount, movementB.amount, AMOUNT_TOLERANCE)
    const areDescriptionsEqual = compareDescriptions(movementA.description, movementB.description)

    if(areAmountEqual && areDescriptionsEqual) {
        return true
    }
}

const getPredictedPeriodicMovements = async (cookies, cardId, billingDates, accountNumber) => {
    const notBilledMovements = await getNotBilledMovements(cookies, cardId)

    const internationalBilledMovements = await Promise.all([
        getInternationalBilledMovements(cookies, cardId, billingDates[0], accountNumber),
        getInternationalBilledMovements(cookies, cardId, billingDates[1], accountNumber),
    ])

    const nationalBilledMovements = await Promise.all([
        getNationalBilledMovements(cookies, cardId, billingDates[0], accountNumber),
        getNationalBilledMovements(cookies, cardId, billingDates[1], accountNumber),
    ])

    const allMovements = [
        ...(notBilledMovements),
        ...(internationalBilledMovements.flatMap(movements => movements)),
        ...(nationalBilledMovements.flatMap(movements => movements))
    ]

    const periodicMovements = []

    allMovements
        .filter(movement => movement.totalInstallments === 1)
        .forEach(movement => {
            const isAlreadyPredicted = periodicMovements.some(predictedMovement => compareMovements(predictedMovement, movement))

            if(isAlreadyPredicted) {
                return
            }

            const similarMovements = allMovements.filter(otherMovement =>
                otherMovement !== movement &&
                compareMovements(otherMovement, movement)
            )

            if(similarMovements.length >= 2) {
                periodicMovements.push(movement)
            }
        })

    return periodicMovements
}

const formatAmount = (amount) => {
    return chalk.greenBright(new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(amount))
}

const checkAlreadyBilledThisMonth = (billingDates) => {
    const lastBillingDate = new Date(billingDates[0])
    const today = new Date()

    const sameMonth = lastBillingDate.getMonth() === today.getMonth()
    const sameYear = lastBillingDate.getFullYear() === today.getFullYear()
    return sameYear && sameMonth
}

class Log {
    static level = 0

    static setLevel(level) {
        this.level = level
        return this
    }

    static getLevelTabs() {
        return '\t'.repeat(this.level)
    }

    static info(...message) {
        console.log(`${this.getLevelTabs()}${chalk.blueBright('[+]')}`, ...message)
    }

    static result(...message) {
        console.log(`${this.getLevelTabs()}${chalk.greenBright('[=]')}`, ...message)
    }

    static list(message, items) {
        const listToken = `\n${this.getLevelTabs()}\t${chalk.cyan('-')} `
        console.log(`${this.getLevelTabs()}${chalk.greenBright('[=]')} ${message} (${items.length}): ${listToken}${items.join(listToken)}`)
    }
}

const saveResultFile = async (data) => {
    const resultFolderExists = await fs.stat('results').catch(() => null)
    if(!resultFolderExists) {
        await fs.mkdir('results')
    }

    const latestFile = await fs.stat('results/latest.json').catch(() => null)
    if(latestFile) {
        await fs.rename('results/latest.json', `results/${latestFile.birthtime.toISOString().replace(/:/g, '-')}.json`)
    }

    await fs.writeFile('results/latest.json', JSON.stringify(data, null, 4))
}

const readFixedSpences = async () => {
    const data = await fs.readFile('data/fixedSpences.json')
    return JSON.parse(data)
}

const calculateTotalFixedSpences = (fixedSpences) => {
    return fixedSpences.reduce((total, spence) => total + spence.amount, 0)
}

const app = async () => {
    Log.info('Obteniendo cookies')
    const cookies = await getCookies()

    const usdPrice = await getUsdPrice(cookies)
    Log.info('Precio del dólar:', usdPrice)

    Log.info('Obteniendo tarjetas de crédito')
    const creditCards = await getCreditCards(cookies)
    const creditCardsNames = creditCards.map(card => `${card.name} (${card.number})`)
    Log.setLevel(1).list('Tarjetas de crédito encontradas', creditCardsNames)

    const totals = {}

    for (const card of creditCards) {
        const cardId = card.id

        Log.setLevel(0).info(`Tarjeta de crédito: ${card.name} (${card.number})`)

        Log.setLevel(1).info(`Obteniendo fechas de facturación`)
        const { nationalBillingDate, accountNumber } = await getBillingDates(cookies, cardId)

        const alreadyBilled = checkAlreadyBilledThisMonth(nationalBillingDate)

        if(alreadyBilled) {
            Log.setLevel(1).info('Ya se ha facturado este mes')

            Log.setLevel(1).info('Obteniendo resumen de movimientos facturados')

            const nationalBilled = await getNationalBilledResume(cookies, cardId, nationalBillingDate[0], accountNumber)
            Log.setLevel(2).result(`Total facturado nacional: ${formatAmount(nationalBilled)}`)

            const internationalBilled = await getInternationalBilledResume(cookies, cardId, nationalBillingDate[0], accountNumber)
            Log.setLevel(2).result(`Total facturado internacional: ${formatAmount(internationalBilled * usdPrice)}`)

            const totalBilled = nationalBilled + (internationalBilled * usdPrice)
            Log.setLevel(2).result(`Total facturado: ${formatAmount(totalBilled)}`)

            totals[cardId] = {
                totalBilledAmount: totalBilled,
                totalInstallments: 0,
                totalPeriodicAmount: 0
            }
            continue
        }

        Log.setLevel(1).info(`Obteniendo movimientos no facturados`)
        const notBilledMovements = await getNotBilledMovements(cookies, cardId)

        const totalBilledAmount = calculateTotalBilledAmount(notBilledMovements, usdPrice)
        Log.setLevel(2).result(`Total movimientos no facturados: ${formatAmount(totalBilledAmount)}`)

        Log.setLevel(1).info(`Obteniendo movimientos facturados nacionales`)
        const nationalBilledMovements = await getNationalBilledMovements(cookies, cardId, nationalBillingDate[0], accountNumber)

        const totalInstallments = calculateInstallmentsTotals(nationalBilledMovements)
        Log.setLevel(2).result(`Total cuotas: ${formatAmount(totalInstallments)}`)

        Log.setLevel(1).info(`Obteniendo movimientos recurrentes`)
        const predictedPeriodicMovements = await getPredictedPeriodicMovements(cookies, cardId, nationalBillingDate, accountNumber)
        Log.setLevel(2).list('Movimientos recurrentes encontrados', predictedPeriodicMovements.map(movement => `${movement.description} (${formatAmount(movement.amount)})`))
        
        const totalPeriodicAmount = calculatePeriodicMovementsAmount(predictedPeriodicMovements, usdPrice)
        Log.setLevel(2).result(`Total movimientos recurrentes: ${formatAmount(totalPeriodicAmount)}`)

        totals[cardId] = {
            totalBilledAmount,
            totalInstallments,
            totalPeriodicAmount
        }
    }

    const totalBilledAmount = Object.values(totals).reduce((total, card) => total + card.totalBilledAmount, 0)
    const totalInstallments = Object.values(totals).reduce((total, card) => total + card.totalInstallments, 0)
    const totalPeriodicAmount = Object.values(totals).reduce((total, card) => total + card.totalPeriodicAmount, 0)
    const totalsAmount = totalBilledAmount + totalInstallments + totalPeriodicAmount

    const fixedSpences = await readFixedSpences()
    const totalFixedSpences = calculateTotalFixedSpences(fixedSpences)
    Log.setLevel(0).info('Gastos fijos')
    Log.setLevel(1).list('Gastos fijos encontrados', fixedSpences.map(spence => `${spence.name} (${formatAmount(spence.amount)})`))

    Log.setLevel(0).info('Guardando resultados')
    await saveResultFile({
        date: new Date().toISOString(),
        totals,
        totalBilledAmount,
        totalInstallments,
        totalPeriodicAmount,
        totalsAmount
    })

    Log.setLevel(0).info('Totales')
    Log.setLevel(1).result(`Total de movimientos no facturados: ${formatAmount(totalBilledAmount)}`)
    Log.setLevel(1).result(`Total de cuotas: ${formatAmount(totalInstallments)}`)
    Log.setLevel(1).result(`Total de movimientos recurrentes: ${formatAmount(totalPeriodicAmount)}`)
    Log.setLevel(1).result(`Total de movimientos: ${formatAmount(totalsAmount)}`)
    Log.setLevel(1).result(`Total de gastos fijos: ${formatAmount(totalFixedSpences)}`)
    Log.setLevel(1).result(`Total de gastos: ${formatAmount(totalsAmount + totalFixedSpences)}`)
}

await app()