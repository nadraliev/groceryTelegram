import {JSONFilePreset} from 'lowdb/node'
import TelegramBot from "node-telegram-bot-api";

// replace the value below with the Telegram token you receive from @BotFather
const token = process.env.TOKEN;

async function main() {
    // Create a bot that uses 'polling' to fetch new updates
    const bot = new TelegramBot(token, {polling: true});

    const db = await JSONFilePreset(`${process.env.DATA_DIR}/db.json`, {groups: [], defaultGroups: {}})

    const name = (group, id, you) => {
        if (you === id) {
            return 'you'
        } else {
            return group.members.find(member => member.id === id).name
        }
    }

    const calculateTransactions = (group) => {
        const sum = group.members.reduce((sum, member) => sum + (group.expenses.sumPending[member.id] ?? 0), 0)
        const sumForMember = sum / group.members.length

        let deltaForMember = group.members.map(member => {
            return {
                id: member.id,
                delta: group.expenses.sumPending[member.id] ?? 0 - sumForMember,
            }
        }).filter(delta => delta.delta !== 0).sort((a, b) => b.delta - a.delta)

        const transactions = []

        while (deltaForMember.length > 0) {
            const needToCompensate = deltaForMember[0]

            console.log(`receiver ${JSON.stringify(needToCompensate)}`)

            if (needToCompensate && needToCompensate.delta > 0) {
                let closestPayee = {}
                for (const payee of deltaForMember.filter(delta => delta.id !== needToCompensate.id)) {
                    if (closestPayee.delta === undefined || closestPayee.delta > needToCompensate.delta + payee.delta) {
                        closestPayee = payee
                    }
                }

                console.log(`receiver ${JSON.stringify(needToCompensate)}. sender ${JSON.stringify(closestPayee)}`)

                // pay
                const transactionValue = Math.min(Math.abs(closestPayee.delta), needToCompensate.delta)

                transactions.push({
                    from: closestPayee.id,
                    to: needToCompensate.id,
                    value: transactionValue,
                })

                const newValueForReceiver = needToCompensate.delta - transactionValue
                const newValueForPayee = closestPayee.delta + transactionValue

                if (newValueForReceiver === 0) {
                    // no longer participates in transactions
                    deltaForMember = deltaForMember.filter(member => member.id !== needToCompensate.id)
                } else {
                    deltaForMember.find(member => member.id === needToCompensate.id).delta = newValueForReceiver
                }

                if (newValueForPayee === 0) {
                    // no longer participates in transactions
                    deltaForMember = deltaForMember.filter(member => member.id !== closestPayee.id)
                } else {
                    deltaForMember.find(member => member.id === closestPayee.id).delta = newValueForPayee
                }
            }
        }

        return transactions
    }

    bot.onText(/\/create (.+)/, async (msg, match) => {
        const groupName = match[1]

        if (db.data.groups.find(value => value.name === groupName)) {
            bot.sendMessage(msg.chat.id, `Group ${groupName} already exists`)
            return
        }

        const newGroup = {
            name: groupName,
            members: [
                {
                    id: msg.chat.id,
                    name: msg.chat.username,
                }
            ],
            expenses: {
                sumPending: {}, // sum of all pending expenses by person
                pendingTransactions: [],
                fullList: [],
            },
        }

        await db.update(({groups}) => groups.push(newGroup))
        await db.update(({defaultGroups}) => defaultGroups[msg.chat.id] = groupName)

        bot.sendMessage(msg.chat.id, `Group ${groupName} was created`)
    })

    bot.onText(/\/join (.+)/, async (msg, match) => {
        await db.update(({groups, defaultGroups}) => {
            const groupName = match[1]

            const group = groups.find(value => value.name === groupName)

            if (group === undefined) {
                bot.sendMessage(msg.chat.id, `Group ${groupName} was not found`)
            } else {
                if (group.members.includes(msg.chat.id)) {
                    bot.sendMessage(msg.chat.id, `You are already a part of group ${groupName}`)
                } else {
                    group.members.push({
                        id: msg.chat.id,
                        name: msg.chat.username,
                    })
                    defaultGroups[msg.chat.id] = groupName

                    bot.sendMessage(msg.chat.id, `You joined group ${groupName}`)
                }
            }
        })
    })

    bot.onText(/\/status/, async (msg, match) => {
        const defaultGroup = db.data.defaultGroups[msg.chat.id]

        if (defaultGroup === undefined) {
            bot.sendMessage(msg.chat.id, `Default group not set`)
            return
        }

        const group = db.data.groups.find(value => value.name === defaultGroup)

        if (group === undefined) {
            bot.sendMessage(msg.chat.id, `Default group does not exist`)
            return
        }

        const transactions = group.expenses.pendingTransactions

        bot.sendMessage(msg.chat.id, `Pending transactions:
${transactions.map(transaction => `From ${name(group, transaction.from, msg.chat.id)} to ${name(group, transaction.to, msg.chat.id)}: €${transaction.value}\n`)}
        `)
    })

    bot.onText(/\/last (.+)/, async (msg, match) => {
        const defaultGroup = db.data.defaultGroups[msg.chat.id]

        if (defaultGroup === undefined) {
            bot.sendMessage(msg.chat.id, `Default group not set`)
            return
        }

        const group = db.data.groups.find(value => value.name === defaultGroup)

        if (group === undefined) {
            bot.sendMessage(msg.chat.id, `Default group does not exist`)
            return
        }

        const lastItemsNumber = parseInt(match[1], 10)

        if (isNaN(lastItemsNumber)) {
            bot.sendMessage(msg.chat.id, `Invalid number of last items`)
            return
        }

        if (lastItemsNumber > 100) {
            bot.sendMessage(msg.chat.id, `Pick a smaller number`)
            return
        }

        if (lastItemsNumber < 1) {
            bot.sendMessage(msg.chat.id, `Very funny`)
            return
        }

        if (group.expenses.fullList.length === 0) {
            bot.sendMessage(msg.chat.id, `No expenses yet`)
            return
        }

        let expenses = ''

        for (let i = group.expenses.fullList.length - 1; i >= Math.max(0, group.expenses.fullList.length - lastItemsNumber); i--) {
            expenses += `* ${group.expenses.fullList[i].name} for €${group.expenses.fullList[i].value} by ${group.members.find(value => value.id === group.expenses.fullList[i].spender).name}\n`
        }

        bot.sendMessage(msg.chat.id, `Last ${lastItemsNumber} expenses:

${expenses}
        `)
    })

    bot.onText(/\/sent/, async (msg, match) => {
        const defaultGroup = db.data.defaultGroups[msg.chat.id]

        if (defaultGroup === undefined) {
            bot.sendMessage(msg.chat.id, `Default group not set`)
            return
        }

        const group = db.data.groups.find(value => value.name === defaultGroup)

        if (group === undefined) {
            bot.sendMessage(msg.chat.id, `Default group does not exist`)
            return
        }

        const completedTransactions = group.expenses.pendingTransactions.filter(transaction => transaction.from === msg.chat.id)
        group.expenses.pendingTransactions = group.expenses.pendingTransactions.filter(transaction => transaction.from !== msg.chat.id)

        completedTransactions.forEach(transaction => {
            group.expenses.sumPending[transaction.to] = group.expenses.sumPending[transaction.to] - transaction.value
            group.expenses.sumPending[transaction.from] = group.expenses.sumPending[transaction.from] + transaction.value
        })
        await db.write()
    })

    bot.onText(/^([^\/]*)$/, async (msg, match) => {
        const expense = match[0].split(' ')
        const expenseName = expense[0]
        const expenseValue = Number(expense[1])

        if (expenseName === undefined || isNaN(expenseValue)) {
            bot.sendMessage(msg.chat.id, `Invalid name or value`)
            return
        }

        const defaultGroup = db.data.defaultGroups[msg.chat.id]

        if (defaultGroup === undefined) {
            bot.sendMessage(msg.chat.id, `Default group not set`)
            return
        }

        const group = db.data.groups.find(value => value.name === defaultGroup)

        if (group === undefined) {
            bot.sendMessage(msg.chat.id, `Default group does not exist`)
            return
        }

        await db.update(data => {
            group.expenses.sumPending[msg.chat.id] = Number(group.expenses.sumPending[msg.chat.id] ?? 0) + expenseValue
            group.expenses.fullList.push({
                name: expenseName,
                value: expenseValue,
                spender: msg.chat.id,
            })

        })

        await db.update(data => {
            group.expenses.pendingTransactions = calculateTransactions(group)
        })

        bot.sendMessage(msg.chat.id, `${expenseName} added`)
    })

}

main().then(r => {
})
