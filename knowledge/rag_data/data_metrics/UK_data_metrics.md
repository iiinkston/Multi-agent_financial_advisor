# Empirical Market Metrics — UK FTSE 100

## Data Source
Historical index data from local CSV file:
knowledge/csv/UK_FTSE100_history.csv

## Date Range
2020-01-02 → 2025-12-30

Total trading days in dataset: 1512
Approximate years covered: 6.00

## Computed Metrics (derived from dataset only)

All metrics were computed directly from daily close prices in the dataset using standard financial formulas.
No external data or model knowledge was used.

### Return Metrics

- **Total Cumulative Return**: 30.72%
  - Starting close price: 7604.30
  - Ending close price: 9940.70

- **Annualized Return**: 4.57%
  - Computed as: ((Ending Price / Starting Price) ^ (1 / Years)) - 1
  - Based on 6.00 years of data

### Risk Metrics

- **Annualized Volatility**: 16.62%
  - Computed as: Standard Deviation of Daily Returns × √252
  - Based on 1512 trading days

- **Maximum Drawdown**: -34.93%
  - Computed as: Minimum peak-to-trough decline over the dataset period
  - Represents worst-case loss from any peak value

### Daily Return Extremes

- **Worst Single-Day Return**: -10.87%
- **Best Single-Day Return**: 9.05%

## Methodology

All metrics were computed directly from daily close prices in the dataset using standard financial formulas:

1. **Daily Returns**: return_t = (close_t / close_{t-1}) - 1
2. **Cumulative Return**: (close_last / close_first) - 1
3. **Annualized Return**: ((close_last / close_first) ^ (1 / years)) - 1
4. **Annualized Volatility**: std(daily_returns) × √252
5. **Maximum Drawdown**: Minimum of (cumulative / running_max - 1) over all periods

No external data, assumptions, or model knowledge was used. All values are strictly derived from the CSV dataset.

## Data Quality Notes

- Dataset contains 1512 trading days
- Date range: 2020-01-02 to 2025-12-30
- All metrics computed from actual close prices in the dataset
- Missing or invalid data points were excluded from calculations
