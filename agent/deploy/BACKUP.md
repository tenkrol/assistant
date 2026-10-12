# Бэкап агента и бота в Яндекс.Диск

Ежедневно в **01:00 по Москве** (таймер `agent-backup.timer` на Финляндии) собирается
один зашифрованный архив и уходит в Яндекс.Диск.

## Что внутри

```
backup-<дата>.tar.gz.enc        зашифрованный (AES-256, openssl)
├── agent/state.tar.gz          память агента: состояние, сессии DSH, AGENTS.md
├── agent/systemd.tar.gz        юниты агента и сторожа
├── agent/agent.env             настройки и токены агента
└── bot.tar.gz                  с Испании: /var/lib/tg-agent (12 файлов состояния),
                                .env бота, конфиги nginx, renewal сертификатов,
                                юниты tg-agent/vk-agent/disk-guard/certbot
```

Секреты внутри, поэтому архив шифруется. **Пароль лежит в `/etc/agent/agent.env`
(строка `BACKUP_PASSPHRASE`) и продублирован в `/root/.backup-passphrase` на Испании.
Сохраните его отдельно от серверов** — без пароля облачная копия не откроется.

## Восстановление

```sh
# 1. скачать архив с Яндекс.Диска (в веб-интерфейсе или через API)
# 2. расшифровать
openssl enc -d -aes-256-cbc -pbkdf2 -in backup-<дата>.tar.gz.enc -pass pass:'<ПАРОЛЬ>' | tar xzf -
# 3. внутри: agent/ и bot.tar.gz
tar xzf bot.tar.gz -C /            # состояние бота, .env, конфиги nginx, юниты
systemctl daemon-reload && systemctl restart tg-agent vk-agent nginx
# 4. агент
tar xzf agent/state.tar.gz -C /var/lib
tar xzf agent/systemd.tar.gz -C /
cp agent/agent.env /etc/agent/agent.env
systemctl daemon-reload && systemctl restart dsh-agent
```

## Проверка руками

```sh
bash /etc/agent/agent-backup.sh              # запустить вне расписания
systemctl list-timers agent-backup.timer     # следующий запуск
ls -lt /var/lib/agent-backups/               # локальные копии (хранится 7)
```
