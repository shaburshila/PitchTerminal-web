# Remix + MetaMask deploy — LimitOrderExecutor (C2.6)

Файл `LimitOrderExecutor.flat.sol` (рядом) — это flatten'utый контракт со всеми OZ-зависимостями inline. Compound pragma `=0.8.26 ^0.8.20` уже исправлен на `0.8.26` (gotcha из C0.5 deploy lessons).

## Pre-flight checklist

- [ ] HEAD = `aff6a72` (post-audit-batch). Working tree clean.
- [ ] MetaMask на Base Mainnet (chainId 8453).
- [ ] Deployer EOA `0x71ECD1a09380cA46CcA741Bc48d04C556674756F` (shaburshila.base.eth main wallet) подключён в MetaMask, имеет >= 0.0001 ETH на Base.
- [ ] `BASESCAN_KEY` в `contracts/.env.deploy` заполнен (уже есть: `QW3K6ADJ…F28DM`).
- [ ] `RPC_URL_BASE_MAINNET=https://mainnet.base.org` — есть.

## Compiler settings (КРИТИЧНО — должны совпасть для верификации)

- **Compiler version**: `0.8.26+commit.<...>` (выбрать в Remix solidity-compiler tab — версия 0.8.26)
- **Language**: Solidity
- **EVM version**: **`cancun`** ⚠️ (НЕ paris — `foundry.toml` фиксирует cancun, audited bytecode тоже cancun; иначе verify не сматчится)
- **Optimization**: **enabled**, runs = **200**
- **Via IR**: **отключено** (via_ir = false в `foundry.toml`)

## Constructor arguments (порядок ВАЖЕН — 6 полей)

Constructor сигнатура (см. `contracts/src/LimitOrderExecutor.sol` строки 274-301):

```solidity
constructor(
    IERC20  _pitch,
    IHook   _playerHook,
    IHook   _countryHook,
    IRouter _playerRouter,
    IRouter _countryRouter,
    address _owner
)
```

В Remix UI заполнить **в этом порядке**:

| # | Поле                        | Значение                                       |
|---|-----------------------------|------------------------------------------------|
| 1 | `_pitch` (IERC20)           | `0xeaE13ea73BEc936664A51734c8c01ec7c3B0699C` |
| 2 | `_playerHook` (IHook)       | `0xd5252A67935fc6b913C4441ac0E5EBF3219fAAa8` |
| 3 | `_countryHook` (IHook)      | `0xCAE7EbFa18755d1f35eE8e0F3356f375ed5B2Aa8` |
| 4 | `_playerRouter` (IRouter)   | `0x5F231AEA5AbD403aF0e8a32c1feF85a9a3ec5622` |
| 5 | `_countryRouter` (IRouter)  | `0x61Cad011Db02D9924257F536bFD1ea615e42Bb9D` |
| 6 | `_owner` (address)          | `0xF32Db3Bb4e9b7C1bBc2420D83292a6D459BBDd05` |

Address sources (для проверки): `contracts/test/LimitOrderExecutor.fork.t.sol:47-59` (live mainnet — fork-tests уже их использовали). OWNER — тот же admin EOA, что для `PitchTerminalAccess` (см. `project_mainnet_deploy.md`).

## MetaMask

- **Network**: Base Mainnet (chainId 8453)
- **From**: `0x71ECD1a09380cA46CcA741Bc48d04C556674756F` (deployer, тот же что для C0.5)
- **Gas estimate**: ~**2.1M gas** (sanity-check — Anvil-fork smoke показал `~2.1M`; если MetaMask покажет ~72K → ты деплоишь OZ library вместо executor, отмена tx)
- Стоимость: ~$0.00005 (Base @ 0.011 gwei)

⚠️ **Remix 2.2.0 gotcha:** в Deploy & Run tab dropdown «Contract» **обязательно** выбрать `LimitOrderExecutor`. Если выбран первый из flatten (OZ `Address`) — constructor args пропадут, MetaMask покажет ~72K gas вместо ~2.1M, и tx деплоит случайную library. Sanity gas-check критичен.

## ABI-encoded constructor args (для верификации на Basescan)

```
0x000000000000000000000000eae13ea73bec936664a51734c8c01ec7c3b0699c000000000000000000000000d5252a67935fc6b913c4441ac0e5ebf3219faaa8000000000000000000000000cae7ebfa18755d1f35ee8e0f3356f375ed5b2aa80000000000000000000000005f231aea5abd403af0e8a32c1fef85a9a3ec562200000000000000000000000061cad011db02d9924257f536bfd1ea615e42bb9d000000000000000000000000f32db3bb4e9b7c1bbc2420d83292a6d459bbdd05
```

(Регенерировать при необходимости: `cast abi-encode 'constructor(address,address,address,address,address,address)' 0xeaE13… 0xd5252… 0xCAE7E… 0x5F231… 0x61Cad… 0xF32Db…`.)

## Шаги deploy

1. **Remix → File explorer → создать новый файл** `LimitOrderExecutor.flat.sol`, вставить содержимое одноимённого файла из этой папки.
2. **Solidity compiler tab** → выбрать `0.8.26`, EVM version `cancun`, optimization `Yes` / runs `200`, via IR `No` → Compile.
3. **Deploy & Run tab** → Environment `Injected Provider — MetaMask` → проверить chainId = 8453 (Base) → Account = deployer.
4. **Contract dropdown** → выбрать **`LimitOrderExecutor`** (не Address / не другой).
5. Раскрыть оранжевую кнопку Deploy (стрелка вниз) — 6 полей constructor.
6. Заполнить таблицу выше (по порядку).
7. Sanity-check в MetaMask popup: gas ≈ 2.1M (НЕ 72K). Confirm.
8. После confirmation Remix покажет deployed address в Deployed Contracts. **Скопировать его.**

## Post-deploy verify (на Basescan)

Через `forge verify-contract` из shell (этот путь сработал для C0.5, RemixAuto-verify требует ключ в Remix Settings):

```bash
cd contracts
source .env.deploy

$HOME/.foundry/bin/forge verify-contract \
  --chain base \
  --num-of-optimizations 200 \
  --compiler-version v0.8.26+commit.8a97fa7a \
  --constructor-args "$(cast abi-encode 'constructor(address,address,address,address,address,address)' \
      0xeaE13ea73BEc936664A51734c8c01ec7c3B0699C \
      0xd5252A67935fc6b913C4441ac0E5EBF3219fAAa8 \
      0xCAE7EbFa18755d1f35eE8e0F3356f375ed5B2Aa8 \
      0x5F231AEA5AbD403aF0e8a32c1feF85a9a3ec5622 \
      0x61Cad011Db02D9924257F536bFD1ea615e42Bb9D \
      0xF32Db3Bb4e9b7C1bBc2420D83292a6D459BBDd05)" \
  --watch \
  <DEPLOYED_ADDRESS> \
  src/LimitOrderExecutor.sol:LimitOrderExecutor
```

Ожидаемый итог: `Pass - Verified` (full match). Подтверждение: открыть `https://basescan.org/address/<addr>#code` — должен показывать source с зелёной галочкой.

## Post-deploy immutable getters (sanity)

```bash
cd contracts
source .env.deploy
EXEC=<DEPLOYED_ADDRESS>

$HOME/.foundry/bin/cast call $EXEC "PITCH()(address)"          --rpc-url $RPC_URL_BASE_MAINNET
$HOME/.foundry/bin/cast call $EXEC "PLAYER_HOOK()(address)"    --rpc-url $RPC_URL_BASE_MAINNET
$HOME/.foundry/bin/cast call $EXEC "COUNTRY_HOOK()(address)"   --rpc-url $RPC_URL_BASE_MAINNET
$HOME/.foundry/bin/cast call $EXEC "PLAYER_ROUTER()(address)"  --rpc-url $RPC_URL_BASE_MAINNET
$HOME/.foundry/bin/cast call $EXEC "COUNTRY_ROUTER()(address)" --rpc-url $RPC_URL_BASE_MAINNET
$HOME/.foundry/bin/cast call $EXEC "owner()(address)"          --rpc-url $RPC_URL_BASE_MAINNET
$HOME/.foundry/bin/cast call $EXEC "DOMAIN_SEPARATOR()(bytes32)" --rpc-url $RPC_URL_BASE_MAINNET
```

Ожидаемые значения — те же что в constructor args таблице выше. `DOMAIN_SEPARATOR` — bytes32, проверить, что не нулевой.

## VPS env rotation (после verify success)

```bash
# на VPS
ssh shaburshila@64.111.92.113
cd /opt/pitchterminal
sed -i 's|^EXECUTOR_CONTRACT=.*|EXECUTOR_CONTRACT=<DEPLOYED_ADDRESS>|' .env
grep EXECUTOR_CONTRACT .env  # подтвердить
docker compose restart api worker
# smoke: POST /api/v1/orders должен теперь не fail-closed
curl -sS https://pitchwc-terminal.xyz/health  # backend up
```

## Если что-то пошло не так

- **MetaMask gas ~72K** → отмена tx, в Remix Contract dropdown выбран не `LimitOrderExecutor` — пересортировать flatten / перекомпилировать / выбрать правильный.
- **Verify Failed: source not matching** → проверить EVM version (`cancun`, не paris/london), Optimization runs 200, compiler exact patch version (0.8.26+commit.8a97fa7a).
- **Verify Failed: constructor args mismatch** → переустановить hex (без `0x` префикса в Basescan UI).
- **Deploy reverted с `OwnerZeroAddress`** → проверить поле 6 = `0xF32Db3Bb4e9b7C1bBc2420D83292a6D459BBDd05`, не нулевой.
- **`contracts/broadcast/8453/*` после Anvil smoke** — НЕ комитить (fake deploy artefacts).

## Three-roles invariant для C2.6

- **Deployer** = `0x71ECD1a09380cA46CcA741Bc48d04C556674756F` (hot, MetaMask, gas payer, разовый)
- **Owner**    = `0xF32Db3Bb4e9b7C1bBc2420D83292a6D459BBDd05` (admin EOA, тот же что для access-контракта)
- **No treasury** — executor не custodian, не держит средств между tx. Атомарный execute → outBal → user.
