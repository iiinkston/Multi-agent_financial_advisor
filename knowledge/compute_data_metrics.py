#!/usr/bin/env python3
"""
Compute empirical market metrics from CSV data files.
All metrics are computed strictly from the data - no external knowledge used.
Uses only Python standard library - no external dependencies.
"""

import csv
import math
from pathlib import Path
from datetime import datetime

def parse_float(value):
    """Safely parse float, return None if invalid."""
    try:
        return float(value)
    except (ValueError, TypeError):
        return None

def compute_metrics(csv_path, market_name, filename):
    """Compute all required metrics from CSV data."""
    
    close_prices = []
    dates = []
    
    # Read CSV, skipping first 3 rows (headers, ticker, date label)
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        
        # Skip first 3 rows
        next(reader)  # Headers
        next(reader)  # Ticker
        next(reader)  # Date label
        
        # Read data rows
        for row in reader:
            if len(row) < 2:
                continue
            
            # First column is date, second is close price
            date_str = row[0].strip()
            close_str = row[1].strip()
            
            close_price = parse_float(close_str)
            if close_price is not None and close_price > 0:
                close_prices.append(close_price)
                dates.append(date_str)
    
    if len(close_prices) < 2:
        return None, "Insufficient data points (need at least 2 valid close prices)"
    
    # Compute daily returns
    daily_returns = []
    for i in range(1, len(close_prices)):
        if close_prices[i-1] > 0:
            daily_return = (close_prices[i] / close_prices[i-1]) - 1
            daily_returns.append(daily_return)
    
    if len(daily_returns) == 0:
        return None, "Could not compute daily returns"
    
    # Date range
    earliest_date = dates[0]
    latest_date = dates[-1]
    
    # Total cumulative return
    total_return = (close_prices[-1] / close_prices[0]) - 1
    
    # Number of trading days
    n_days = len(daily_returns)
    
    # Annualized return (assuming 252 trading days per year)
    years = n_days / 252.0
    if years > 0:
        annualized_return = ((close_prices[-1] / close_prices[0]) ** (1.0 / years)) - 1
    else:
        annualized_return = None
    
    # Annualized volatility
    if len(daily_returns) > 1:
        # Calculate mean
        mean_return = sum(daily_returns) / len(daily_returns)
        
        # Calculate variance
        variance = sum((r - mean_return) ** 2 for r in daily_returns) / (len(daily_returns) - 1)
        
        # Standard deviation
        daily_vol = math.sqrt(variance)
        annualized_volatility = daily_vol * math.sqrt(252)
    else:
        annualized_volatility = None
    
    # Maximum drawdown
    cumulative = [1.0]  # Start at 1.0
    for ret in daily_returns:
        cumulative.append(cumulative[-1] * (1 + ret))
    
    running_max = [cumulative[0]]
    for i in range(1, len(cumulative)):
        running_max.append(max(running_max[-1], cumulative[i]))
    
    drawdowns = [(cumulative[i] - running_max[i]) / running_max[i] for i in range(len(cumulative))]
    max_drawdown = min(drawdowns)
    
    # Worst and best daily returns
    worst_daily_return = min(daily_returns)
    best_daily_return = max(daily_returns)
    
    return {
        'market_name': market_name,
        'filename': filename,
        'earliest_date': earliest_date,
        'latest_date': latest_date,
        'n_days': n_days,
        'years': years,
        'annualized_return': annualized_return,
        'annualized_volatility': annualized_volatility,
        'max_drawdown': max_drawdown,
        'worst_daily_return': worst_daily_return,
        'best_daily_return': best_daily_return,
        'total_return': total_return,
        'first_close': close_prices[0],
        'last_close': close_prices[-1]
    }, None

def fmt_pct(val):
    """Format percentage."""
    if val is None or (isinstance(val, float) and math.isnan(val)):
        return "N/A (insufficient data)"
    return f"{val * 100:.2f}%"

def generate_markdown(metrics, error_msg=None):
    """Generate markdown file from computed metrics."""
    
    if error_msg:
        content = f"""# Empirical Market Metrics — {metrics['market_name']}

## Data Source
Historical index data from local CSV file:
knowledge/csv/{metrics['filename']}

## Error
{error_msg}

This dataset does not contain sufficient information to compute metrics.
"""
        return content
    
    # Format dates
    earliest = metrics['earliest_date']
    latest = metrics['latest_date']
    
    content = f"""# Empirical Market Metrics — {metrics['market_name']}

## Data Source
Historical index data from local CSV file:
knowledge/csv/{metrics['filename']}

## Date Range
{earliest} → {latest}

Total trading days in dataset: {metrics['n_days']}
Approximate years covered: {metrics['years']:.2f}

## Computed Metrics (derived from dataset only)

All metrics were computed directly from daily close prices in the dataset using standard financial formulas.
No external data or model knowledge was used.

### Return Metrics

- **Total Cumulative Return**: {fmt_pct(metrics['total_return'])}
  - Starting close price: {metrics['first_close']:.2f}
  - Ending close price: {metrics['last_close']:.2f}

- **Annualized Return**: {fmt_pct(metrics['annualized_return'])}
  - Computed as: ((Ending Price / Starting Price) ^ (1 / Years)) - 1
  - Based on {metrics['years']:.2f} years of data

### Risk Metrics

- **Annualized Volatility**: {fmt_pct(metrics['annualized_volatility'])}
  - Computed as: Standard Deviation of Daily Returns × √252
  - Based on {metrics['n_days']} trading days

- **Maximum Drawdown**: {fmt_pct(metrics['max_drawdown'])}
  - Computed as: Minimum peak-to-trough decline over the dataset period
  - Represents worst-case loss from any peak value

### Daily Return Extremes

- **Worst Single-Day Return**: {fmt_pct(metrics['worst_daily_return'])}
- **Best Single-Day Return**: {fmt_pct(metrics['best_daily_return'])}

## Methodology

All metrics were computed directly from daily close prices in the dataset using standard financial formulas:

1. **Daily Returns**: return_t = (close_t / close_{{t-1}}) - 1
2. **Cumulative Return**: (close_last / close_first) - 1
3. **Annualized Return**: ((close_last / close_first) ^ (1 / years)) - 1
4. **Annualized Volatility**: std(daily_returns) × √252
5. **Maximum Drawdown**: Minimum of (cumulative / running_max - 1) over all periods

No external data, assumptions, or model knowledge was used. All values are strictly derived from the CSV dataset.

## Data Quality Notes

- Dataset contains {metrics['n_days']} trading days
- Date range: {earliest} to {latest}
- All metrics computed from actual close prices in the dataset
- Missing or invalid data points were excluded from calculations
"""
    
    return content

def main():
    """Main function to process all CSV files."""
    
    base_dir = Path(__file__).parent
    csv_dir = base_dir / 'csv'
    output_dir = base_dir / 'rag_data' / 'data_metrics'
    
    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Market configurations
    markets = [
        ('US', 'US_Sp500_history.csv', 'US S&P 500'),
        ('UK', 'UK_FTSE100_history.csv', 'UK FTSE 100'),
        ('SG', 'SG_STI_history.csv', 'Singapore STI'),
        ('HK', 'HK_HSI_history.csv', 'Hong Kong HSI'),
        ('CN', 'CN_SSE_history.csv', 'China SSE')
    ]
    
    for market_code, filename, market_name in markets:
        csv_path = csv_dir / filename
        
        if not csv_path.exists():
            print(f"Warning: {csv_path} not found, skipping...")
            continue
        
        print(f"Processing {market_name}...")
        
        metrics, error = compute_metrics(csv_path, market_name, filename)
        
        if error:
            metrics = {'market_name': market_name, 'filename': filename}
        
        markdown_content = generate_markdown(metrics, error)
        
        output_file = output_dir / f'{market_code}_data_metrics.md'
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(markdown_content)
        
        print(f"  ✓ Created {output_file}")
        
        if not error:
            print(f"    Date range: {metrics['earliest_date']} to {metrics['latest_date']}")
            print(f"    Annualized return: {fmt_pct(metrics['annualized_return'])}")
            print(f"    Annualized volatility: {fmt_pct(metrics['annualized_volatility'])}")
    
    print("\n✓ All data metrics files generated successfully!")

if __name__ == '__main__':
    main()
