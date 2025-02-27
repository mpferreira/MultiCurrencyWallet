import Web3 from 'web3'
import InputDataDecoder from 'ethereum-input-data-decoder'
import TokenAbi from 'human-standard-token-abi'
import { BigNumber } from 'bignumber.js'
import { getState } from 'redux/core'
import actions from 'redux/actions'
import reducers from 'redux/core/reducers'
import DEFAULT_CURRENCY_PARAMETERS from 'common/helpers/constants/DEFAULT_CURRENCY_PARAMETERS'
import EVM_CONTRACTS_ABI from 'common/helpers/constants/EVM_CONTRACTS_ABI'
import TOKEN_STANDARDS from 'helpers/constants/TOKEN_STANDARDS'
import ethLikeHelper from 'common/helpers/ethLikeHelper'
import erc20Like from 'common/erc20Like'
import { apiLooper, constants, cacheStorageGet, cacheStorageSet, feedback } from 'helpers'
import externalConfig from 'helpers/externalConfig'
import metamask from 'helpers/metamask'
import getCoinInfo from 'common/coins/getCoinInfo'

const NETWORK = process.env.MAINNET ? 'mainnet' : 'testnet'
const Decoder = new InputDataDecoder(TokenAbi)


class Erc20LikeAction {
  readonly currency: string
  readonly currencyKey: string
  readonly standard: string // (ex. erc20, bep20, ...)
  readonly explorerName: string
  readonly explorerLink: string
  readonly explorerApiKey: string
  readonly adminFeeObj: {
    fee: string // percent of amount
    address: string // where to send
    min: string // min amount
  }
  private Web3: IUniversalObj

  constructor(params) {
    const {
      currency,
      standard,
      explorerName,
      explorerLink,
      explorerApiKey,
      adminFeeObj,
      web3,
    } = params

    this.currency = currency
    this.currencyKey = currency.toLowerCase()
    this.standard = standard
    this.explorerName = explorerName
    this.explorerLink = explorerLink
    this.explorerApiKey = explorerApiKey
    this.adminFeeObj = adminFeeObj
    this.Web3 = web3
  }

  reportError = (error, details = '') => {
    feedback.actions.failed(
      ''.concat(
        `Details => standard: ${this.standard}`,
        details ? `, ${details}` : '',
        ` | Error message - ${error.message} `
      )
    )
    console.group(`Actions >%c ${this.standard}`, 'color: red;')
    console.error('error: ', error)
    console.groupEnd()
  }

  getCurrentWeb3 = () => metamask.getWeb3() || this.Web3

  getTokenContract = (contractAddr) => {
    const web3 = this.getCurrentWeb3()

    return new web3.eth.Contract(TokenAbi, contractAddr)
  }

  addToken = (params) => {
    const { standard, contractAddr, symbol, decimals, baseCurrency } = params
    const customTokens = this.getCustomTokensConfig()
    const privateKey = localStorage.getItem(constants.privateKeyNames[baseCurrency])

    customTokens[NETWORK][standard][contractAddr] = {
      address: contractAddr,
      symbol,
      decimals,
      baseCurrency,
      standard: this.standard,
    }

    localStorage.setItem(constants.localStorage.customToken, JSON.stringify(customTokens))
    this.login(privateKey, contractAddr, symbol, decimals, symbol)
  }

  getInfoAboutToken = async (contractAddress) => {
    const isContract = await actions[this.currencyKey].isContract(contractAddress)

    try {      
      if (isContract) {
        const Web3 = await actions[this.currencyKey].getCurrentWeb3()
        const contract = new Web3.eth.Contract(TokenAbi, contractAddress)

        const name = await contract.methods.name().call()
        const symbol = await contract.methods.symbol().call()
        const decimals = await contract.methods.decimals().call()
  
        return {
          name,
          symbol,
          decimals: Number(decimals),
        }
      } 
    } catch (error) {
      this.reportError(error)
    }

    return false
  }

  getCustomTokensConfig = () => {
    const customTokens = JSON.parse(localStorage.getItem(constants.localStorage.customToken) || '{}')
    const fillInTokensConfig = (configName) => {
      customTokens[configName] = {}

      Object.keys(TOKEN_STANDARDS).forEach((key) => {
        const standard = TOKEN_STANDARDS[key].standard

        customTokens[configName][standard] = {}
      })
    }

    if (!customTokens.testnet) {
      fillInTokensConfig('testnet')
    }

    if (!customTokens.mainnet) {
      fillInTokensConfig('mainnet')
    }

    return customTokens
  }

  getTx = (txRaw) => {
    return txRaw.transactionHash
  }

  getTxRouter = (txId, currency) => {
    return `/token/${currency}/tx/${txId}`
  }

  getLinkToInfo = (tx) => {
    if (!tx) return
    return `${this.explorerLink}/tx/${tx}`
  }

  getBalance = async (tokenName) => {
    if (tokenName === undefined) return

    const {
      address: ownerAddress,
      contractAddress,
      decimals,
      name,
      tokenKey
    } = this.returnTokenInfo(tokenName)

    if(metamask.isConnected() && !metamask.isAvailableNetworkByCurrency(tokenKey)) return

    const address = metamask.isConnected() ? metamask.getAddress() : ownerAddress
    const balanceInCache = cacheStorageGet('currencyBalances', `token_${tokenKey}_${address}`)

    if (balanceInCache !== false) {
      reducers.user.setTokenBalance({
        baseCurrency: this.currencyKey,
        name,
        amount: balanceInCache,
      })
      return balanceInCache
    }

    try {
      const amount = await this.fetchBalance(address, contractAddress, decimals)

      reducers.user.setTokenBalance({
        baseCurrency: this.currencyKey,
        name,
        amount,
      })
      cacheStorageSet('currencyBalances', `token_${tokenKey}_${address}`, amount, 30)

      return amount
    } catch (error) {
      console.error(error)

      reducers.user.setTokenBalanceError({
        baseCurrency: this.currencyKey,
        name,
      })
    }
  }

  getTransaction = (ownAddress, tokenName): Promise<IUniversalObj[]> => {
    return new Promise((res) => {
      const { user: { tokensData } } = getState()
      // if we have a base currency prefix then delete it
      tokenName = tokenName.replace(/^\{[a-z]+\}/, '')
      const tokenKey = `{${this.currencyKey}}${tokenName.toLowerCase()}`
      const { address = ownAddress, contractAddress } = tokensData[tokenKey]


      const url = ''.concat(
        `?module=account&action=tokentx`,
        `&contractaddress=${contractAddress}`,
        `&address=${address}`,
        `&startblock=0&endblock=99999999`,
        `&sort=asc&apikey=${this.explorerApiKey}`
      )

      return apiLooper
        .get(this.explorerName, url, {
          cacheResponse: 30 * 1000, // 30 seconds
        })
        .then((response: IUniversalObj) => {
          if (Array.isArray(response.result)) {
            const transactions = response.result
              .filter((item) => item.value > 0)
              .map((item) => ({
                confirmations: item.confirmations,
                type: tokenName.toLowerCase(),
                standard: this.standard,
                baseCurrency: this.currencyKey,
                hash: item.hash,
                contractAddress: item.contractAddress,
                status: item.blockHash !== null ? 1 : 0,
                value: new BigNumber(String(item.value))
                  .dividedBy(new BigNumber(10).pow(Number(item.tokenDecimal)))
                  .toNumber(),
                address: item.to,
                date: item.timeStamp * 1000,
                direction: address.toLowerCase() === item.to.toLowerCase() ? 'in' : 'out',
              }))
              .filter((item) => {
                if (
                  item.direction === 'in' ||
                  !this.adminFeeObj ||
                  address.toLowerCase() === this.adminFeeObj.address.toLowerCase()
                ) {
                  return true
                }

                if (item.address.toLowerCase() === this.adminFeeObj.address.toLowerCase()) {
                  return false
                }

                return true
              })

            res(transactions)
          } else {
            res([])
          }
        })
        .catch((error) => {
          this.reportError(error)
          res([])
        })
    })
  }

  fetchBalance = async (address, contractAddress, decimals) => {
    const Web3 = this.getCurrentWeb3()
    const contract = new Web3.eth.Contract(TokenAbi, contractAddress)
    const result = await contract.methods.balanceOf(address).call()

    return new BigNumber(String(result))
      .dividedBy(new BigNumber(String(10)).pow(decimals))
      .toNumber()
  }

  fetchTokenTxInfo = async (ticker, hash) => {
    return new Promise(async (res) => {
      let txInfo = await this.fetchTxInfo(hash)

      if (txInfo && txInfo.isContractTx) {
        // This is tx to contract. Fetch all txs and find this tx
        const transactions: IUniversalObj = await this.getTransaction(txInfo.senderAddress, ticker)
        const ourTx = transactions.filter((tx) => tx.hash.toLowerCase() === hash.toLowerCase())

        if (ourTx.length) {
          txInfo.amount = ourTx[0].value
          txInfo.adminFee = false // Swap doesn't have service fee

          if (ourTx[0].direction == `in`) {
            txInfo = {
              ...txInfo,
              receiverAddress: txInfo.senderAddress,
              senderAddress: txInfo.receiverAddress,
            }
          }
        }
      }

      res(txInfo)
    })
  }

  fetchTxInfo = async (hash): Promise<IUniversalObj | false> => {
    return new Promise(async (res) => {
      const {
        user: { tokensData },
      } = getState()
      const Web3 = this.getCurrentWeb3()
      Web3.eth.getTransaction(hash)
        .then((tx) => {
          let amount = 0
          let receiverAddress = tx.to
          const contractAddress = tx.to
          let tokenDecimal = 18

          for (const key in tokensData) {
            if (
              tokensData[key]?.decimals &&
              tokensData[key]?.contractAddress?.toLowerCase() == contractAddress.toLowerCase()
            ) {
              tokenDecimal = tokensData[key].decimals
              break
            }
          }

          const txData = Decoder.decodeData(tx.input)

          if (
            (txData && txData.inputs?.length === 2 && txData.name === `transfer`) ||
            txData.method === `transfer`
          ) {
            receiverAddress = `0x${txData.inputs[0]}`
            amount = new BigNumber(txData.inputs[1])
              .div(new BigNumber(10).pow(tokenDecimal))
              .toNumber()
          }

          const { from, gas, gasPrice, blockHash } = tx

          const minerFee = new BigNumber(Web3.utils.toBN(gas).toNumber())
            .multipliedBy(Web3.utils.toBN(gasPrice).toNumber())
            .dividedBy(1e18)
            .toNumber()

          let adminFee: number | false = false

          if (this.adminFeeObj) {
            const feeFromUsersAmount = new BigNumber(this.adminFeeObj.fee)
              .dividedBy(100)
              .multipliedBy(amount)

            if (new BigNumber(this.adminFeeObj.min).isGreaterThan(feeFromUsersAmount)) {
              adminFee = new BigNumber(this.adminFeeObj.min).toNumber()
            } else {
              adminFee = feeFromUsersAmount.toNumber()
            }
          }

          res({
            amount,
            afterBalance: null,
            receiverAddress,
            senderAddress: from,
            minerFee,
            minerFeeCurrency: this.currency,
            adminFee,
            confirmed: blockHash !== null,
            isContractTx:
              contractAddress.toLowerCase() === externalConfig.swapContract[this.standard].toLowerCase(),
          })
        })
        .catch((error) => {
          this.reportError(error)
          res(false)
        })
    })
  }

  fetchFees = async (params) => {
    const { gasPrice, gasLimit, speed } = params
    const newGasPrice = gasPrice || await ethLikeHelper[this.currencyKey].estimateGasPrice({ speed })
    const newGasLimit = gasLimit || DEFAULT_CURRENCY_PARAMETERS.evmLikeToken.limit.send

    return {
      gas: newGasLimit,
      gasPrice: newGasPrice,
    }
  }

  login = (privateKey, contractAddress, nameContract, decimals, fullName) => {
    let data

    const Web3 = this.getCurrentWeb3()
    if (privateKey) {
      data = Web3.eth.accounts.privateKeyToAccount(privateKey)
    } else {
      data = Web3.eth.accounts.create()
      Web3.eth.accounts.wallet.add(data)
    }

    Web3.eth.accounts.wallet.add(data.privateKey)
    this.setupContract(data.address, contractAddress, nameContract, decimals, fullName)
  }

  setupContract = (ethAddress, contractAddress, nameContract, decimals, fullName) => {
    const Web3 = this.getCurrentWeb3()
    if (!Web3.eth.accounts.wallet[ethAddress]) {
      throw new Error('web3 does not have given address')
    }

    let data = {
      address: ethAddress,
      balance: 0,
      name: nameContract.toLowerCase(),
      fullName,
      currency: nameContract.toUpperCase(),
      contractAddress,
      decimals,
      isMetamask: false,
      isConnected: false,
      // TODO: use a standard key and delete this key
      isERC20: this.standard === 'erc20',
      standard: this.standard,
      isToken: true,
      blockchain: TOKEN_STANDARDS[this.standard].currency,
      baseCurrency: this.currencyKey,
      tokenKey: `{${this.currencyKey}}${nameContract.toLowerCase()}`,
    }

    if (metamask.isEnabled() && metamask.isConnected()) {
      data = {
        ...data,
        address: metamask.getAddress(),
        isMetamask: true,
        isConnected: true,
      }
    }


    reducers.user.setTokenAuthData({
      baseCurrency: this.currencyKey,
      name: data.name,
      data,
    })

  }

  send = async (params) => {
    const { name, from, to, amount, ...feeConfig } = params
    const { contractAddress, tokenContract, decimals } = this.returnTokenInfo(name)
    const feeResult = await this.fetchFees({ ...feeConfig })
    const txArguments = {
      gas: feeResult.gas,
      gasPrice: feeResult.gasPrice,
      from,
    }

    const hexAmountWithDecimals = new BigNumber(amount)
      .multipliedBy(10 ** decimals)
      .toString(16)
    const walletData = actions.core.getWallet({
      address: from,
      currency: name,
    })

    return new Promise(async (res, rej) => {
      txArguments.gas = 200_000
      const gasAmountCalculated = await tokenContract.methods
        .transfer(to, '0x' + hexAmountWithDecimals)
        .estimateGas(txArguments)

      const gasAmounWithPercentForSuccess = new BigNumber(
        new BigNumber(gasAmountCalculated)
          .multipliedBy(1.05) // + 5% -  множитель добавочного газа, если будет фейл транзакции - увеличит (1.05 +5%, 1.1 +10%)
          .toFixed(0)
      ).toString(16)

      txArguments.gas = '0x' + gasAmounWithPercentForSuccess

      const receipt = tokenContract.methods
        // hex amount fixes a BigNumber error
        .transfer(to, '0x' + hexAmountWithDecimals)
        .send(txArguments)
        .on('transactionHash', (hash) => res({ transactionHash: hash }))
        .on('error', (error) => {
          this.reportError(error)
          rej(error)
        })

      // Admin fee transaction
      if (this.adminFeeObj && !walletData.isMetamask) {
        receipt.then(() => {
          this.sendAdminTransaction({
            txArguments,
            tokenContract,
            decimals,
            amount,
          })
        })
      }
    })
  }

  sendAdminTransaction = async (params) => {
    const { tokenContract, amount, decimals, txArguments } = params
    const minAmount = new BigNumber(this.adminFeeObj.min)
    let feeFromUsersAmount = new BigNumber(this.adminFeeObj.fee)
      .dividedBy(100) // 100 %
      .multipliedBy(amount)

    if (minAmount.isGreaterThan(feeFromUsersAmount)) {
      feeFromUsersAmount = minAmount
    }

    const hexFeeWithDecimals = feeFromUsersAmount
      .multipliedBy(10 ** decimals)
      .toString(16)

    return new Promise(async (res) => {
      txArguments.gas = 200_000
      const gasAmountCalculated = await tokenContract.methods
        .transfer(this.adminFeeObj.address, '0x' + hexFeeWithDecimals)
        .estimateGas(txArguments)

      const gasAmounWithPercentForSuccess = new BigNumber(
        new BigNumber(gasAmountCalculated)
          .multipliedBy(1.05) // + 5% -  множитель добавочного газа, если будет фейл транзакции - увеличит (1.05 +5%, 1.1 +10%)
          .toFixed(0)
      ).toString(16)

      txArguments.gas = '0x' + gasAmounWithPercentForSuccess

      await tokenContract.methods
        // hex amount fixes a BigNumber error
        .transfer(this.adminFeeObj.address, '0x' + hexFeeWithDecimals)
        .send(txArguments)
        .on('transactionHash', (hash) => {
          console.group('%c Admin commission is sended', 'color: green;')
          console.log('standard', this.standard)
          console.log('tx hash', hash)
          console.groupEnd()
          res(hash)
        })
    })
  }

  approve = async (params): Promise<string> => {
    const { name, to, amount } = params
    const { tokenContract, decimals } = this.returnTokenInfo(name)
    const feeResult = await this.fetchFees({ speed: 'fast' })

    const hexWeiAmount = new BigNumber(amount)
      .multipliedBy(10 ** decimals)
      .toString(16)

    return new Promise(async (res, rej) => {
      const receipt = await tokenContract.methods
        .approve(to, '0x' + hexWeiAmount)
        .send(feeResult)
        .on('transactionHash', (hash) => {
          console.group('Actions >%c approve the token', 'color: green')
          console.log(`standard: ${this.standard}; name: ${name}`)
          console.log('tx hash: ', hash)
          console.groupEnd()
        })
        .catch((error) => {
          this.reportError(error)
          rej(error)
          return
        })

      res(receipt.transactionHash)
    })
  }

  checkSwapExists = async (params) => {
    const { ownerAddress, participantAddress } = params
    const Web3 = this.getCurrentWeb3()
    const swapContract = new Web3.eth.Contract(EVM_CONTRACTS_ABI.TOKEN_SWAP, externalConfig.swapContract[this.standard])

    const swap = await swapContract.methods.swaps(ownerAddress, participantAddress).call()
    const balance = swap && swap.balance ? parseInt(swap.balance) : 0

    return balance > 0
  }

  setAllowance = async (params) => {
    const { name, to, targetAllowance } = params
    const { decimals, address, contractAddress } = this.returnTokenInfo(name)

    try {
      const allowance = await erc20Like[this.standard].checkAllowance({
        owner: address,
        spender: externalConfig.swapContract[this.standard],
        contract: contractAddress,
        decimals,
      })

      // if contract has enough allowance then skip
      if (new BigNumber(targetAllowance).isLessThanOrEqualTo(allowance)) {
        return Promise.resolve()
      }

      return this.approve({ name, to, amount: targetAllowance })
    } catch (error) {
      this.reportError(error)
    }
  }

  returnTokenInfo = (name) => {
    if (!name) throw new Error(`${this.standard} actions; returnTokenInfo(name): name is undefined`)
    const Web3 = this.getCurrentWeb3()

    try {
      const { user: { tokensData } } = getState()
      const tokenInfo = getCoinInfo(name)
      const tokenKey = !tokenInfo.blockchain ? `{${this.currencyKey}}${name.toLowerCase()}` : name.toLowerCase()

      const { address, contractAddress, decimals, name: tokenName } = tokensData[tokenKey]

      const tokenContract = new Web3.eth.Contract(TokenAbi, contractAddress, {
        from: address,
      })

      return {
        address,
        name: tokenName,
        tokenKey,
        contractAddress,
        tokenContract,
        decimals,
      }
    } catch (error) {
      this.reportError(error, `${name}, part: returnTokenInfo`)
      throw new Error(error)
    }
  }
}

export default {
  erc20: new Erc20LikeAction({
    currency: 'ETH',
    standard: 'erc20',
    explorerName: 'etherscan',
    explorerLink: externalConfig.link.etherscan,
    explorerApiKey: externalConfig.api.etherscan_ApiKey,
    adminFeeObj: externalConfig.opts?.fee?.erc20,
    web3: new Web3( new Web3.providers.HttpProvider(externalConfig.web3.provider) ),
  }),
  bep20: new Erc20LikeAction({
    currency: 'BNB',
    standard: 'bep20',
    explorerName: 'bscscan',
    explorerLink: externalConfig.link.bscscan,
    explorerApiKey: externalConfig.api.bscscan_ApiKey,
    adminFeeObj: externalConfig.opts?.fee?.bep20,
    web3: new Web3( new Web3.providers.HttpProvider(externalConfig.web3.binance_provider) ),
  }),
  erc20matic: new Erc20LikeAction({
    currency: 'MATIC',
    standard: 'erc20matic',
    explorerName: 'explorer-mumbai',
    explorerLink: externalConfig.link.maticscan,
    explorerApiKey: externalConfig.api.polygon_ApiKey,
    adminFeeObj: externalConfig.opts?.fee?.erc20matic,
    web3: new Web3( new Web3.providers.HttpProvider(externalConfig.web3.matic_provider) ),
  })
}
