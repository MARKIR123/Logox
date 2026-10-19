---
name: material-design
description: "Google Material Design system guidelines: elevation, physical motion curves & component hierarchy"
actors: [kalon]
---

# Material Design System SOP (Material Design 物理隐喻规范)

## 1. Elevation and Shadow Physics
- Surface heights cast realistic ambient and directional shadows.
- Level 0 (Ground): flat `#ffffff` or `#121212`.
- Level 1 (Card): subtle shadow `0 1px 3px rgba(0,0,0,0.12)`.
- Level 2 (Menu/Picker): `0 3px 6px rgba(0,0,0,0.16)`.
- Level 3 (Modal/Dialog): `0 10px 20px rgba(0,0,0,0.19)`.

## 2. Motion Easing Curves
- Standard curve (elements moving within screen): `cubic-bezier(0.4, 0.0, 0.2, 1)`.
- Deceleration curve (incoming elements): `cubic-bezier(0.0, 0.0, 0.2, 1)`.
- Acceleration curve (outgoing elements): `cubic-bezier(0.4, 0.0, 1, 1)`.
- Duration standards: Micro-interactions 150-200ms; Sheet/Modal reveals 250-350ms. Never exceed 400ms.

## 3. Density and Padding Rhythm
- Base 4dp/8dp spatial grid. All padding, margins, and heights must be multiples of 4 or 8.
