/**
 * SHARED GAIT CONSTANTS — the small set of gait tuning values used on BOTH sides
 * of the movement-template split: by the gait BUILDERS (services/movementTemplates)
 * and by the gait MODIFIERS that reshape a built gait (services/gaitModifiers).
 *
 * They live in their own leaf module so neither side has to reach across the
 * other's file for a value — and so no builder depends on a `const` declared
 * further down the module it happens to share (module-scope consts are read at
 * call time, which hid that ordering hazard until the file was split).
 *
 * Builder-only or modifier-only tuning does NOT belong here; it belongs next to
 * the code it serves. This module is deliberately tiny.
 */

/** Real free-gait COM vertical excursion is ~4-5 cm peak-to-peak at a comfortable
 *  cadence [Perry & Burnfield; Gard & Childress]. This is the calibrated NORMAL
 *  target; `gaitBounce` (services/gaitModifiers) scales around it, and the travel
 *  walk publishes it as its `verticalCalibrationCm`. */
export const NORMAL_GAIT_VERTICAL_CM = 5;
