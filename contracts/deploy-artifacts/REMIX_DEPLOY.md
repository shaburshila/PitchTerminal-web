# Remix + MetaMask deploy — параметры

Файл `PitchTerminalAccess.flat.sol` (рядом) — это flatten'utый контракт со всеми OZ-зависимостями inline.

## Compiler settings (КРИТИЧНО — должны совпасть для верификации)

- **Compiler version**: `0.8.26+commit.<...>` (выбрать в Remix solidity-compiler tab — версия 0.8.26)
- **Language**: Solidity
- **EVM version**: `paris` (или `default` если Remix не показывает paris явно — но 0.8.26 default = paris)
- **Optimization**: **enabled**, runs = **200**
- **Via IR**: **отключено** (via_ir = false в foundry.toml)

## Constructor arguments (порядок ВАЖЕН)

Remix UI попросит ввести 6 значений по очереди. Constructor сигнатура:

```solidity
constructor(
    IERC20 _pitch,
    address _treasury,
    uint256 _price,
    uint16 _buyerDiscountBps,
    uint16 _referralBps,
    address _owner
)
```

Заполнить:

| # | Поле | Значение |
|---|---|---|
| 1 | `_pitch` (IERC20) | `0xeae13ea73bec936664a51734c8c01ec7c3b0699c` |
| 2 | `_treasury` (address) | `0xc217D2649758aBae26437316FcEe3FaB730EEBE4` |
| 3 | `_price` (uint256) | `1000000000000000000` |
| 4 | `_buyerDiscountBps` (uint16) | `2500` |
| 5 | `_referralBps` (uint16) | `2500` |
| 6 | `_owner` (address) | `0xF32Db3Bb4e9b7C1bBc2420D83292a6D459BBDd05` |

## MetaMask

- **Network**: Base Mainnet (chainId 8453)
- **From**: `0x71ECD1a09380cA46CcA741Bc48d04C556674756F` (deployer)
- **Gas**: оставить дефолтным; estimate ~1.28M @ ~0.01 gwei ≈ $0.00004

## ABI-encoded constructor args (для верификации на Basescan)

```
0x000000000000000000000000eae13ea73bec936664a51734c8c01ec7c3b0699c000000000000000000000000c217d2649758abae26437316fcee3fab730eebe40000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000009c400000000000000000000000000000000000000000000000000000000000009c4000000000000000000000000f32db3bb4e9b7c1bbc2420d83292a6d459bbdd05
```

## После deploy

1. Скопировать адрес задеплоенного контракта (Remix покажет в Deployed Contracts).
2. Открыть https://basescan.org/address/<deployed_address> → Contract → Verify and Publish.
3. Compiler Type: Solidity (Single file)
4. Compiler Version: v0.8.26+commit (точно такая же, как использовал Remix — посмотреть в Remix logs)
5. License: None (UNLICENSED)
6. Optimization: Yes, Runs 200
7. EVM Version: paris
8. Source code: вставить содержимое `PitchTerminalAccess.flat.sol`
9. Constructor args ABI: вставить hex выше (БЕЗ префикса `0x`)
10. Verify & Publish.
