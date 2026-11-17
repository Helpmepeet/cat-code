#!/usr/bin/env bun
import { enableConfigs } from '../../src/utils/config.js'
import { observedAccounts } from './transport.js'

enableConfigs()
console.log(JSON.stringify(await observedAccounts(), null, 2))
