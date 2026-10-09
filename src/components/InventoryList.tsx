import {
  ChevronDown,
  ChevronRight,
  CookingPot,
  Ellipsis,
  Minus,
  Package,
  Search,
  Snowflake,
} from 'lucide-react';
import { daysBetween, daysUntil, formatQuantity, todayDate } from '../domain/inventory';
import {
  type Batch,
  type InventoryGroup,
  type Product,
  LOCATION_LABELS,
  STORAGE_LOCATIONS,
} from '../domain/types';
import {
  dateLabel,
  expiryLabel,
  foodIcon,
  groupExpiry,
  stapleCaption,
} from './inventoryPresentation';

const locationIcons = {
  fridge: <Package size={17} />,
  freezer: <Snowflake size={17} />,
  pantry: <CookingPot size={17} />,
};

export interface InventoryListProps {
  groups: InventoryGroup[];
  expanded: string | null;
  selected: string[];
  onToggleGroup: (id: string) => void;
  onToggleSelected: (group: InventoryGroup) => void;
  onEdit: (batch: Batch, product: Product) => void;
  onUse: (batch: Batch) => void;
  onClearFilters: () => void;
}

export function InventoryList({
  groups,
  expanded,
  selected,
  onToggleGroup,
  onToggleSelected,
  onEdit,
  onUse,
  onClearFilters,
}: InventoryListProps) {
  return (
    <>
      <div className="list-heading">
        <span>INGREDIENT</span>
        <span>QUANTITY</span>
        <span>EXPIRATION</span>
      </div>
      {groups.length === 0 && (
        <div className="no-results">
          <Search size={26} />
          <h3>No items here yet.</h3>
          <p>Try another location, search, or filter.</p>
          <button className="text-button" onClick={onClearFilters}>
            Clear filters
          </button>
        </div>
      )}
      {STORAGE_LOCATIONS.map((storage) => {
        const items = groups.filter((group) => group.location === storage);
        return (
          items.length > 0 && (
            <section
              className="storage-section"
              key={storage}
              aria-label={LOCATION_LABELS[storage]}
            >
              <div className="section-label">
                {locationIcons[storage]}
                <h2>{LOCATION_LABELS[storage]}</h2>
                <span>{items.length}</span>
              </div>
              {items.map((group) => {
                const date = groupExpiry(group);
                const near = date && daysUntil(date) <= 3;
                return (
                  <div
                    key={group.id}
                    className={`inventory-group ${expanded === group.id ? 'expanded' : ''}`}
                  >
                    <div className="inventory-row">
                      <label className="checkbox-hit">
                        <input
                          className="item-checkbox"
                          type="checkbox"
                          aria-label={`Select ${group.product.name} in ${LOCATION_LABELS[storage]}`}
                          checked={group.batches.every((batch) => selected.includes(batch.id))}
                          onChange={() => onToggleSelected(group)}
                        />
                      </label>
                      <button
                        className="item-main"
                        onClick={() => onToggleGroup(group.id)}
                        aria-expanded={expanded === group.id}
                      >
                        <span className="food-icon" aria-hidden="true">
                          {foodIcon(group.product.name)}
                        </span>
                        <span className="item-name">
                          <strong>{group.product.name}</strong>
                          <small>
                            {group.product.brand ? `${group.product.brand} · ` : ''}
                            {group.batches.length > 1
                              ? `${group.batches.length} purchase batches`
                              : `Bought ${dateLabel(group.batches[0].purchasedOn)}`}
                            {group.product.isStaple && <span className="staple-tag">Staple</span>}
                          </small>
                        </span>
                      </button>
                      <span className="item-quantity">
                        {group.hasMixedUnits
                          ? `${group.batches.length} batches`
                          : formatQuantity(group.quantity, group.unit)}
                        {group.product.isStaple && (
                          <small
                            className={
                              group.batches.some(
                                (batch) =>
                                  batch.stapleStatus === 'low' || batch.stapleStatus === 'empty',
                              )
                                ? 'low-stock'
                                : ''
                            }
                          >
                            {stapleCaption(group)}
                          </small>
                        )}
                      </span>
                      <span className={`expiry-badge ${near ? 'soon' : !date ? 'undated' : ''}`}>
                        {near && <span />}
                        {expiryLabel(date)}
                      </span>
                      <button
                        className="icon-button row-expand"
                        aria-label={`Show batches for ${group.product.name}`}
                        onClick={() => onToggleGroup(group.id)}
                      >
                        {expanded === group.id ? (
                          <ChevronDown size={19} />
                        ) : (
                          <ChevronRight size={19} />
                        )}
                      </button>
                    </div>
                    {expanded === group.id && (
                      <div className="batch-list">
                        {group.batches.map((batch) => (
                          <div className="batch-card" key={batch.id}>
                            <div>
                              <strong>{formatQuantity(batch.quantity, batch.unit)}</strong>
                              <p>
                                Bought {dateLabel(batch.purchasedOn)}
                                <span>·</span>
                                {daysBetween(batch.purchasedOn, todayDate())}d ago
                              </p>
                              <small>
                                {batch.expiresOn
                                  ? `Expiration: ${dateLabel(batch.expiresOn)}`
                                  : 'Expiration not set'}
                              </small>
                            </div>
                            <div className="batch-actions">
                              <button onClick={() => onUse(batch)}>
                                <Minus size={15} />
                                Used some
                              </button>
                              <button onClick={() => onEdit(batch, group.product)}>
                                <Ellipsis size={19} />
                                Edit
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )
        );
      })}
    </>
  );
}
