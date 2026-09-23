// Snapshot Greeks exposed by ThetaData Options Pro. The first four retain
// their existing historical fields; the remainder use the live OI proxies.
export const OPTION_PRO_GREEKS = [
  ["delta", "dex_signed_raw", "#ff5c8a"],
  ["gamma", "gamma_exposure_raw", "#4cc9f0"],
  ["charm", "charm_exposure_raw", "#8de05d"],
  ["speed", "speed_exposure_raw", "#ffae35"],
  ...["theta", "vega", "rho", "epsilon", "lambda", "vanna", "vomma", "veta", "vera", "zomma", "color", "ultima", "dual_delta", "dual_gamma"]
    .map(key => [key, `greek_${key}_raw`, "#a88bff"]),
].map(([key, field, color]) => ({ key, field, color, label: key.replaceAll("_", " ").toUpperCase() }));

export const EXTRA_GREEK_FIELDS = OPTION_PRO_GREEKS.slice(4).map(line => line.field);
