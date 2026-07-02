import type { AppRoute } from '../../app/routing';

export type TourAction = 'click' | 'observe';

export type TourPosition = 'top' | 'bottom' | 'left' | 'right' | 'top-right' | 'bottom-right';

export type TourStep = {
  id: string;
  title: string;
  description: string;
  target: string;
  route?: AppRoute;
  action?: TourAction;
  position?: TourPosition;
  required?: boolean;
  moduleId?: string;
  waitFor?: () => boolean;
};

export type TourStatus = 'idle' | 'active' | 'completed';

export type TourState = {
  status: TourStatus;
  steps: TourStep[];
  currentIndex: number;
};
