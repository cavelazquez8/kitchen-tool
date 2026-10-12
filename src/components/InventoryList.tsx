import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CookingPot,
  Ellipsis,
  Minus,
  Package,
  Plus,
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
import './inventory-polish.css';

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
  onDeduct: (batch: Batch) => void;
  onAddOne: (batch: Batch) => void;
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
  onDeduct,
  onAddOne,
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
                const countableBatches = group.batches
                  .filter(
                    (batch) =>
                      batch.quantity !== null &&
                      [
                        'each',
                        'item',
                        'items',
                        'count',
                        'ct',
                        'package',
                        'packages',
                        'piece',
                        'pieces',
                        'can',
                        'cans',
                        'bottle',
                        'bottles',
                        'carton',
                        'cartons',
                        'bag',
                        'bags',
                        'packet',
                        'packets',
                      ].includes(batch.unit.trim().toLowerCase()),
                  )
                  .sort((a, b) => (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999'));
                const countable =
                  countableBatches.find(
                    (batch) => batch.quantity !== null && batch.quantity >= 1,
                  ) ?? countableBatches[0];

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
                      <div className="item-main">
                        <button
                          className="item-summary"
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
                        {!group.product.ingredientName?.trim() && (
                          <button
                            type="button"
                            className="recipe-match-indicator"
                            aria-label={`Set recipe match for ${group.product.name}`}
                            title="Recipe matching ingredient name is missing. Set it for clearer matches."
                            onClick={() => onEdit(group.batches[0], group.product)}
                          >
                            <CircleHelp size={15} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                      <span className="item-quantity">
                        <span className="quantity-text">
                          {group.hasMixedUnits
                            ? `${group.batches.length} batches`
                            : formatQuantity(group.quantity, group.unit)}
                        </span>
                        {countable && (
                          <span
                            className="quantity-stepper"
                            role="group"
                            aria-label={`Quick quantity for ${group.product.name}`}
                          >
                            <button
                              type="button"
                              aria-label={`Use one ${group.product.name}`}
                              title={`Use 1 ${countable.unit} from the earliest dated available batch`}
                              disabled={countable.quantity === null || countable.quantity < 1}
                              onClick={() => onDeduct(countable)}
                            >
                              <Minus size={16} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              aria-label={`Add one ${group.product.name}`}
                              title={`Add 1 ${countable.unit} to this purchase batch`}
                              onClick={() => onAddOne(countable)}
                            >
                              <Plus size={16} aria-hidden="true" />
                            </button>
                          </span>
                        )}
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
                              {batch.quantity !== null && (
                                <span
                                  className="quantity-stepper"
                                  role="group"
                                  aria-label={`Quantity for ${group.product.name}, bought ${dateLabel(batch.purchasedOn)}`}
                                >
                                  <button
                                    type="button"
                                    aria-label={`Use 1 ${batch.unit || 'item'} of ${group.product.name}`}
                                    title={`Use 1 ${batch.unit || 'item'}`}
                                    disabled={batch.quantity < 1}
                                    onClick={() => onDeduct(batch)}
                                  >
                                    <Minus size={16} aria-hidden="true" />
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Add 1 ${batch.unit || 'item'} to ${group.product.name}`}
                                    title={`Add 1 ${batch.unit || 'item'}`}
                                    onClick={() => onAddOne(batch)}
                                  >
                                    <Plus size={16} aria-hidden="true" />
                                  </button>
                                </span>
                              )}
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
