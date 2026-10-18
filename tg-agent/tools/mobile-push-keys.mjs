#!/usr/bin/env node
/**
 * Выпуск пары VAPID-ключей для Web Push мобильного сайта.
 *
 * Печатает готовые строки для `.env`; приватный ключ никуда не сохраняет.
 * Повторный выпуск сломает уже выданные подписки — делайте это только при
 * первой настройке или осознанной ротации.
 */
import { createVapidKeys } from '../src/mobile-push.mjs'

const keys = createVapidKeys()
console.log('# добавьте в /opt/tg-agent/.env и перезапустите сервис')
console.log(`MOBILE_VAPID_PUBLIC_KEY=${keys.publicKey}`)
console.log(`MOBILE_VAPID_PRIVATE_KEY=${keys.privateKey}`)
console.log('MOBILE_VAPID_SUBJECT=https://tenkrol.ru')
