import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, description, children, className = '' }: ModalProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal ${className}`}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            // Radix listens for Escape on the document before the field sees it. When a
            // suggestion list is open, the first Escape closes only that list and keeps
            // the unsaved entry; a second Escape closes the dialog.
            const focused = event.target instanceof Element ? event.target : null;
            if (focused?.closest('[role="combobox"][aria-expanded="true"]')) event.preventDefault();
          }}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description}</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="Close">
              <X size={21} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
